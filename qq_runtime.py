"""Manage the independent official NapCat OneKey runtime on this computer."""
import hashlib
import ctypes
from contextlib import contextmanager
import json
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit
from settings import DATA,atomic_write,protect
from runtime_paths import node_executable

def paths():
    try:meta=json.loads((DATA/'qq/runtime.json').read_text(encoding='utf8'))
    except (OSError,ValueError):raise ValueError('请先安装或选择 NapCat 独立运行目录') from None
    return {**meta,'shell':Path(meta['shell']),'core':Path(meta['core'])}

def configure(shell):
    root=Path(shell).resolve()
    cores=sorted(root.glob('versions/*/resources/app/napcat/napcat.mjs'))
    if not (root/'QQ.exe').is_file() or not (root/'NapCatWinBootMain.exe').is_file() or not cores:raise ValueError('这不是完整的 NapCat OneKey 独立目录')
    core=cores[-1].parent;config=core/'config/webui.json';config.parent.mkdir(parents=True,exist_ok=True)
    try:existing=json.loads(config.read_text(encoding='utf8'))
    except (OSError,ValueError):existing={}
    token=existing.get('token') or secrets.token_urlsafe(32)
    port=existing.get('port',6099)
    if type(port) is not int or not 1024<=port<=65535:raise ValueError('NapCat管理端口无效')
    existing.update(host='127.0.0.1',port=port,token=token,disableWebUI=False)
    atomic_write(config,json.dumps(existing,ensure_ascii=False,indent=2).encode('utf8'))
    atomic_write(DATA/'qq/webui.dpapi',protect(token.encode('utf8')))
    atomic_write(DATA/'qq/runtime.json',json.dumps({'shell':str(root),'core':str(core),'port':port},ensure_ascii=False).encode('utf8'))
    return {'installed':True}

def available(port):
    try:
        with socket.create_connection(('127.0.0.1',port),timeout=.5):return True
    except OSError:return False

def start():
    meta=paths()
    if available(meta['port']):return {'started':False}
    folder=DATA/'qq';folder.mkdir(parents=True,exist_ok=True)
    # OneKey's launcher takes only an optional QQ number, unlike Shell's launcher.
    with (folder/'napcat.log').open('a',encoding='utf8') as log:
        process=subprocess.Popen([str(meta['shell']/'NapCatWinBootMain.exe')],cwd=meta['shell'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    atomic_write(folder/'napcat-process.json',json.dumps({'pid':process.pid,'path':str(meta['shell']/'NapCatWinBootMain.exe'),'at':time.time()}).encode('utf8'))
    return {'started':True}

@contextmanager
def webui_lock():
    kernel=ctypes.windll.kernel32;kernel.CreateMutexW.restype=ctypes.c_void_p
    name='Local\\YuYiQQWebUI_'+hashlib.sha256(str(DATA.resolve()).encode()).hexdigest()[:16]
    handle=kernel.CreateMutexW(None,False,name)
    if not handle:raise OSError('无法锁定QQ接口会话')
    try:
        if kernel.WaitForSingleObject(ctypes.c_void_p(handle),10000) not in (0,128):raise ValueError('QQ接口正忙，请稍后重试')
        try:yield
        finally:kernel.ReleaseMutex(ctypes.c_void_p(handle))
    finally:kernel.CloseHandle(ctypes.c_void_p(handle))


def api(action,body=None):
    meta=paths();token=protect((DATA/'qq/webui.dpapi').read_bytes(),True).decode('utf8')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(route,data,credential=None):
        headers={'Content-Type':'application/json'}
        if credential:headers['Authorization']='Bearer '+credential
        req=urllib.request.Request('http://127.0.0.1:'+str(meta['port'])+'/api/'+route,data=json.dumps(data).encode('utf8'),headers=headers)
        with opener.open(req,timeout=15) as response:result=json.load(response)
        if result.get('code')!=0:
            if result.get('message')=='Unauthorized':raise PermissionError('QQ接口会话已失效')
            raise ValueError('NapCat暂未完成登录或本机接口不可用')
        return result.get('data')
    file=DATA/'qq/webui-session.dpapi'
    fingerprint=hashlib.sha256((str(meta['port'])+' '+token).encode()).hexdigest()
    with webui_lock():
        try:session=json.loads(protect(file.read_bytes(),True).decode('utf8'))
        except (OSError,ValueError):session={}
        if session.get('fingerprint')!=fingerprint:session={}
        if session.get('retryAt',0)>time.time():raise ValueError('QQ接口登录频率受限，请稍后刷新')
        def authenticate():
            try:
                auth=request('auth/login',{'hash':hashlib.sha256((token+'.napcat').encode('utf8')).hexdigest()})
                credential=auth.get('Credential') if isinstance(auth,dict) else None
                if not credential:raise ValueError('NapCat本机验证失败')
            except (ValueError,PermissionError):
                atomic_write(file,protect(json.dumps({'fingerprint':fingerprint,'retryAt':time.time()+65}).encode()))
                raise ValueError('QQ接口登录暂时不可用，请稍后刷新') from None
            atomic_write(file,protect(json.dumps({'fingerprint':fingerprint,'credential':credential,'at':time.time()}).encode()))
            return credential
        credential=session.get('credential') if time.time()-session.get('at',0)<3000 else None
        if not credential:credential=authenticate()
        try:return request(action,body or {},credential)
        except PermissionError:
            # Only an explicit authentication rejection is safe to repeat.
            return request(action,body or {},authenticate())

def worker_alive(worker):
    from ctypes import wintypes
    pid=worker.get('pid')
    if type(pid) is not int or not 0<pid<2**32:return False
    kernel=ctypes.windll.kernel32;kernel.OpenProcess.restype=ctypes.c_void_p
    handle=kernel.OpenProcess(0x1000|0x100000,False,pid)
    if not handle:return False
    handle=ctypes.c_void_p(handle)
    try:
        if kernel.WaitForSingleObject(handle,0)!=258:return False
        size=wintypes.DWORD(32768);image=ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle,0,image,ctypes.byref(size)):return False
        if Path(image.value).resolve()!=Path(node_executable()).resolve():return False
        times=[wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle,*(ctypes.byref(value) for value in times)):return False
        created=((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)/10000000-11644473600
        return created<=float(worker.get('at',0))+1
    except (OSError,TypeError,ValueError):return False
    finally:kernel.CloseHandle(handle)


def status():
    try:meta=paths()
    except ValueError:return {'installed':False,'running':False,'loggedIn':False,'detail':'尚未安装QQ运行环境'}
    result={'installed':True,'running':available(meta['port']),'loggedIn':False}
    if not result['running']:return result|{'detail':'QQ连接尚未启动'}
    try:
        login=api('QQLogin/CheckLoginStatus')
        result.update(loggedIn=login.get('isLogin') is True,loginPhase=login.get('loginPhase'),qrAccepted=bool(login.get('qrLoginAccepted')))
        if result['loggedIn']:
            info=api('QQLogin/GetQQLoginInfo');bot=str(info.get('uin') or info.get('user_id') or '')
            result.update(bot=bot,nickname=str(info.get('nick') or info.get('nickname') or bot)[:80],detail='QQ已登录')
        else:result['detail']='请扫码并在手机确认登录'
    except Exception:result['detail']='QQ本机接口暂时不可用'
    try:
        worker=json.loads((DATA/'qq/state.json').read_text(encoding='utf8'))
        cfg=json.loads((DATA/'config.json').read_text(encoding='utf8'))
        if not cfg.get('enabled') or cfg.get('run_id')!=worker.get('runId') or (DATA/'stop').exists():
            worker.update(state='stopped',detail='已停止QQ回复')
        elif not json.loads((DATA/'qq/settings.json').read_text(encoding='utf8')).get('enabled'):
            worker.update(state='disabled',detail='QQ回复未启用')
        elif worker.get('bot')!=result.get('bot'):
            worker.update(state='connecting',detail='正在核对QQ连接')
        elif not worker_alive(worker):
            worker.update(state='reconnecting',detail='QQ回复进程未运行，等待恢复')
        result['worker']={k:worker[k] for k in ('state','detail','at','bot','nickname') if k in worker}
    except (OSError,ValueError):pass
    return result

def qr():
    start()
    deadline=time.monotonic()+20
    while not available(paths()['port']) and time.monotonic()<deadline:time.sleep(.5)
    login=api('QQLogin/CheckLoginStatus')
    if login.get('isLogin'):return {'loggedIn':True}
    url=(api('QQLogin/RefreshQRcode') or {}).get('qrcodeurl')
    if not isinstance(url,str) or not url.startswith('https://') or len(url)>8192:raise ValueError('QQ二维码尚未就绪，请稍后重试')
    sys.path.insert(0,str(DATA.parent/'runtime'));import qrcode
    file=DATA/'qq/login-qr.png';file.parent.mkdir(parents=True,exist_ok=True)
    qrcode.make(url).save(file)
    return {'ready':True}

def prepare():
    from qq_settings import connection_settings
    login=api('QQLogin/CheckLoginStatus')
    if not login.get('isLogin'):return {'ready':False}
    connection=connection_settings();url=urlsplit(connection['url'])
    config=api('OB11Config/GetConfig');network=config.setdefault('network',{})
    desired={'name':'yuyi-ai','enable':True,'host':'127.0.0.1','port':url.port,'messagePostFormat':'array','reportSelfMessage':False,'token':connection['token'],'enableForcePushEvent':True,'debug':False,'heartInterval':30000}
    desired_network={key:[] for key in ('httpServers','httpSseServers','httpClients','websocketServers','websocketClients','plugins')}
    desired_network['websocketServers']=[desired]
    if network!=desired_network:
        # This dedicated runtime must not publish private QQ events to other endpoints.
        config['network']=desired_network
        api('OB11Config/SetConfig',{'config':json.dumps(config,ensure_ascii=False)})
    return {'ready':True}

if __name__=='__main__':
    try:
        action=sys.argv[1] if len(sys.argv)==2 else ''
        if action=='status':result=status()
        elif action=='start':result=start()
        elif action=='qr':result=qr()
        elif action=='prepare':result=prepare()
        elif action=='configure':result=configure(json.loads(sys.stdin.read(16385)).get('shell',''))
        else:raise ValueError('QQ接入操作无效')
        print(json.dumps(result,ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,ValueError) else 'QQ本机连接暂时不可用','status':400},ensure_ascii=False));sys.exit(1)
