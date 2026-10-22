"""Open the adapted upstream v1.2.0 console on loopback."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from settings import DATA
from v12_bridge import UPSTREAM
from runtime_paths import node_executable, python_executable


def ours(url):
    try:
        with urllib.request.urlopen(url+'/api/state',timeout=1) as response:
            return json.load(response).get('appId') in {'ai-yuyi', 'ai-yuyi'}
    except Exception:return False


def open_console(url):
    try:
        if webbrowser.open(url):
            return
    except (OSError, webbrowser.Error):
        pass
    for variable in ('ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'):
        edge = os.path.join(os.environ.get(variable, ''), 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        if os.path.isfile(edge):
            subprocess.Popen([edge, url], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            return
    raise RuntimeError('控制台已启动，请在浏览器打开：' + url)


def main(open_browser=True):
    DATA.mkdir(parents=True, exist_ok=True)
    (UPSTREAM/'data').mkdir(parents=True, exist_ok=True)
    saved=DATA/'console.json'
    if saved.exists():
        try:
            current=json.loads(saved.read_text(encoding='utf-8'))
            if isinstance(current,dict) and isinstance(current.get('url'),str) and current['url'] in {f'http://127.0.0.1:{p}' for p in range(7788,7798)} and ours(current['url']):
                if open_browser:open_console(current['url'])
                return current['url']
        except (ValueError,KeyError,OSError,TypeError):pass
    for port in range(7788,7798):
        with socket.socket() as probe:
            try:probe.bind(('127.0.0.1',port))
            except OSError:continue
        env=os.environ.copy()
        env.update(WX_CONSOLE_PORT=str(port),WX_CONSOLE_HOST='127.0.0.1',WX_DESKTOP_PYTHON=python_executable())
        url=f'http://127.0.0.1:{port}'
        with (DATA/'console.log').open('a',encoding='utf-8') as output:
            proc=subprocess.Popen([node_executable(),str(UPSTREAM/'console'/'server.mjs')],cwd=UPSTREAM,env=env,stdout=output,stderr=output,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            if ours(url):
                saved.write_text(json.dumps({'url':url,'pid':proc.pid}),encoding='utf-8')
                if open_browser:open_console(url)
                return url
            if proc.poll() is not None:break
            time.sleep(.1)
        if proc.poll() is None:
            proc.terminate()
            try:proc.wait(timeout=3)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
    raise RuntimeError('本地控制台未启动，请查看 data/console.log')


if __name__=='__main__':
    try:main()
    except Exception as exc:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None,str(exc),'语忆AI',0x10)
