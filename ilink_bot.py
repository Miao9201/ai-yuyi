"""DPAPI credential helper and hidden supervisor for the network transport."""
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from settings import ROOT,DATA,protect,load_key,load_config
from runtime_paths import node_executable
from account_store import account_dir,save_credential,load_credential,load_accounts,assert_current_worker,registry_lock

AUTH=DATA/'ilink-auth.dpapi'


def helper(action):
    ident=os.environ.get('WX_ILINK_ACCOUNT_ID','');folder=account_dir(ident)
    assert_current_worker(ident)
    folder.mkdir(parents=True,exist_ok=True);auth=folder/'ilink-auth.dpapi'
    if action=='--credential-load':
        print(json.dumps(load_credential(ident),ensure_ascii=False))
    elif action=='--credential-save':
        data=json.loads(sys.stdin.read())
        save_credential(ident,data)
    elif action=='--credential-clear':
        with registry_lock():assert_current_worker(ident);auth.unlink(missing_ok=True)
    elif action=='--qr':
        sys.path.insert(0,str(ROOT/'runtime'))
        import qrcode
        content=sys.stdin.read().strip()
        if not content or len(content)>8192:raise ValueError('二维码资料无效')
        img=qrcode.make(content,box_size=8,border=4)
        tmp=folder/'ilink-qr.tmp.png';img.save(tmp);tmp.replace(folder/'ilink-qr.png')
    else:raise ValueError('未知操作')


def stop_child(proc):
    if proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()


class WorkerPool:
    def __init__(self,spawn,status,on_error=lambda *args:None):
        self.spawn=spawn;self.status=status;self.on_error=on_error;self.children={};self.retry={};self.blocked={}

    def error(self,ident,revision):
        self.retry[ident]=(revision,time.monotonic()+10)
        try:self.on_error(ident,revision)
        except Exception:pass  # A full/unwritable disk must not stop healthy accounts.

    def reconcile(self,rows,primary_enabled=True):
        desired={'':{'revision':''}} if primary_enabled else {}
        desired.update({r['id']:r for r in rows if r['enabled']})
        for ident,child in list(self.children.items()):
            row=desired.get(ident);proc=child['proc']
            revision=row['revision'] if row else child['revision'];retry=self.retry.get(ident)
            if retry and retry[0]==revision and time.monotonic()<retry[1]:continue
            try:
                if not row or row['revision']!=child['revision']:
                    stop_child(proc);del self.children[ident];self.retry.pop(ident,None)
                elif proc.poll() is not None:
                    del self.children[ident]
                    if self.status(ident).get('state') in ('auth_expired','auth_conflict','needs_verification'):
                        self.blocked[ident]=child['revision']
                    else:self.retry[ident]=(child['revision'],time.monotonic()+10)
            except Exception:self.error(ident,revision)
        for ident,row in desired.items():
            revision=row['revision']
            if ident in self.children or self.blocked.get(ident)==revision:continue
            retry=self.retry.get(ident)
            if retry and retry[0]==revision and time.monotonic()<retry[1]:continue
            try:self.children[ident]={'revision':revision,'proc':self.spawn(ident,revision)}
            except Exception:self.error(ident,revision)

    def close(self):
        for ident,child in self.children.items():
            try:stop_child(child['proc'])
            except Exception:
                try:self.on_error(ident,child['revision'])
                except Exception:pass
        self.children.clear()


def main():
    kernel=ctypes.windll.kernel32
    kernel.CreateMutexW.restype=ctypes.c_void_p
    handle=kernel.CreateMutexW(None,False,'Local\\YuYiAIBot_SingleWorker')
    if not handle:raise OSError('无法创建工作进程锁')
    if kernel.GetLastError()==183:
        kernel.CloseHandle(ctypes.c_void_p(handle));return
    cfg=load_config();run_id=cfg['run_id'];pool=None;qq_worker=None
    project=ROOT/'upstream-v1.2.0';pidfile=project/'data'/'bridge.pid'
    try:
        env=os.environ.copy();env.update(DEEPSEEK_API_KEY=load_key(),WX_DESKTOP_PYTHON=str(Path(sys.executable).with_name('python.exe')),WX_COMPANION_RUN_ID=run_id)
        pidfile.write_text(str(os.getpid()),encoding='ascii')
        env.pop('WX_ILINK_ACCOUNT_ID',None);env.pop('WX_ILINK_ACCOUNT_REVISION',None)
        def spawn(ident,revision):
            folder=account_dir(ident);folder.mkdir(parents=True,exist_ok=True)
            child_env={**env,'WX_ILINK_ACCOUNT_ID':ident,'WX_ILINK_ACCOUNT_REVISION':revision}
            status={'state':'starting','detail':'正在启动微信连接','at':time.time(),'accountRevision':revision,'runId':run_id}
            tmp=folder/'status.supervisor.tmp';tmp.write_text(json.dumps(status,ensure_ascii=False),encoding='utf8');tmp.replace(folder/'status.json')
            log_file=folder/'run.log' if ident else project/'data/run.log'
            with log_file.open('a',encoding='utf8') as log:
                return subprocess.Popen([node_executable(),str(project/'ilink-runtime.mjs')],cwd=project,env=child_env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        def status(ident):
            try:return json.loads((account_dir(ident)/'status.json').read_text(encoding='utf8'))
            except (OSError,ValueError):return {}
        def on_error(ident,revision):
            folder=account_dir(ident);folder.mkdir(parents=True,exist_ok=True)
            payload={'state':'error','detail':'此账号工作进程暂时不可用，10 秒后重试；其他账号继续运行','at':time.time(),'accountRevision':revision,'runId':run_id}
            tmp=folder/'status.supervisor.tmp';tmp.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf8');tmp.replace(folder/'status.json')
        pool=WorkerPool(spawn,status,on_error)
        import qq_settings
        from qq_bot import QQWorker,spawn_worker,error_state
        qq_worker=QQWorker(lambda:spawn_worker(env),error_state)
        while True:
            now=load_config()
            if (DATA/'stop').exists() or not now.get('enabled') or now.get('run_id')!=run_id:break
            try:platforms=qq_settings.load_config()
            except Exception:platforms={'wechatEnabled':True,'enabled':False}
            pool.reconcile(load_accounts() if platforms['wechatEnabled'] else [],primary_enabled=platforms['wechatEnabled'])
            qq_worker.reconcile(platforms['enabled']);time.sleep(.5)
    finally:
        if qq_worker:qq_worker.close()
        if pool:
            pool.close()
            tmp=DATA/'status.ilink-stop.tmp'
            tmp.write_text(json.dumps({'state':'stopped','detail':'已停止回复，未发送的任务已保存','at':time.time(),'transport':'ilink'},ensure_ascii=False),encoding='utf-8');tmp.replace(DATA/'status.json')
        kernel.CloseHandle(ctypes.c_void_p(handle))


if __name__=='__main__':
    if len(sys.argv)>1:
        try:helper(sys.argv[1])
        except ValueError as exc:
            print(json.dumps({'error':str(exc)},ensure_ascii=False));sys.exit(1)
    else:main()
