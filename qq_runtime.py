"""Manage the independent official NapCat OneKey runtime on this computer."""
import hashlib
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

def api(action,body=None):
    meta=paths();token=protect((DATA/'qq/webui.dpapi').read_bytes(),True).decode('utf8')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(route,data,credential=None):
        headers={'Content-Type':'application/json'}
        if credential:headers['Authorization']='Bearer '+credential
        req=urllib.request.Request('http://127.0.0.1:'+str(meta['port'])+'/api/'+route,data=json.dumps(data).encode('utf8'),headers=headers)
        with opener.open(req,timeout=15) as response:result=json.load(response)
        if result.get('code')!=0:raise ValueError('NapCat暂未完成登录或本机接口不可用')
        return result.get('data')
    auth=request('auth/login',{'hash':hashlib.sha256((token+'.napcat').encode('utf8')).hexdigest()})
    credential=auth.get('Credential') if isinstance(auth,dict) else None
    if not credential:raise ValueError('NapCat本机验证失败')
    return request(action,body or {},credential)

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
    current=network.get('websocketServers',[])
    if current!=[desired]:
        # This is a dedicated runtime, so no other endpoint may publish private QQ events.
        config['network']={key:[] for key in ('httpServers','httpSseServers','httpClients','websocketServers','websocketClients','plugins')}
        config['network']['websocketServers']=[desired]
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
