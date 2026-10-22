"""Local console lifecycle for the ordinary-friend adapter."""
import argparse
import ctypes
from pathlib import Path
import subprocess
import sys
import time
import uuid
from settings import DATA,ROOT,KEYFILE,load_config,save_config


def running():
    kernel=ctypes.windll.kernel32
    kernel.OpenMutexW.restype=ctypes.c_void_p
    handle=kernel.OpenMutexW(0x100000,False,'Local\\YuYiAIBot_SingleWorker')
    if handle:kernel.CloseHandle(ctypes.c_void_p(handle))
    return bool(handle)


def launch(name,*args):
    pythonw=Path(sys.executable).with_name('pythonw.exe')
    return subprocess.Popen([str(pythonw),'-X','utf8',str(ROOT/name),*args],cwd=ROOT,creationflags=subprocess.CREATE_NO_WINDOW)


def stop(wait=False):
    cfg=load_config();cfg['enabled']=False;save_config(cfg)
    (DATA/'stop').write_text('stop',encoding='ascii')
    if wait:
        deadline=time.monotonic()+25
        while running() and time.monotonic()<deadline:time.sleep(.1)
        if running():raise RuntimeError('已禁止新回复，工作进程仍在退出，请稍后刷新')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['start','restart','stop','locate','config'])
    parser.add_argument('--resume',action='store_true',help='Only for a controlled code update with a verified saved baseline')
    args=parser.parse_args();action=args.action
    if action=='stop':stop(wait=True);return
    if action=='config':launch('settings.py');return
    if action=='locate':
        from desktop import locate
        locate();return
    if action=='restart':
        stop()
        deadline=time.monotonic()+60
        while running() and time.monotonic()<deadline:time.sleep(.25)
    if running():
        if load_config().get('enabled') and not (DATA/'stop').exists():return
        raise RuntimeError('工作进程仍在退出，请稍后再启动')
    if not KEYFILE.exists():raise RuntimeError('请先填写 API 配置')
    cfg=load_config();cfg['enabled']=True;cfg['run_id']=uuid.uuid4().hex;save_config(cfg)
    (DATA/'stop').unlink(missing_ok=True)
    if cfg.get('transport')=='ilink':launch('ilink_bot.py')
    else:launch('bot.py',*(['--resume'] if args.resume else []))


if __name__=='__main__':main()
