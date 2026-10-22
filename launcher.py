"""Open the adapted upstream v1.2.0 console on loopback."""
import json
import hashlib
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from settings import DATA
from v12_bridge import UPSTREAM
from runtime_paths import node_executable, python_executable


def ours(url):
    try:
        with urllib.request.urlopen(url+'/api/state',timeout=1) as response:
            state = json.load(response)
            identity = hashlib.sha256(os.path.normcase(str(Path(__file__).resolve().parent)).encode('utf-8')).hexdigest()
            return state.get('appId') == 'ai-yuyi' and state.get('instanceId') == identity
    except Exception:return False


def open_console(url):
    executable = Path(__file__).resolve().with_name('语忆AI.exe')
    if not executable.is_file():
        raise RuntimeError('桌面启动程序不完整，请重新安装完整版本。')
    subprocess.Popen([str(executable), '--url', url], cwd=executable.parent)


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
    try:
        if sys.argv[1:] == ['--console-url']:
            print(main(open_browser=False), flush=True)
        elif not sys.argv[1:]:
            main()
        else:
            raise ValueError('无法识别的启动参数')
    except Exception as exc:
        if sys.argv[1:] == ['--console-url']:
            print(str(exc), file=sys.stderr)
        else:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None,str(exc),'语忆AI',0x10)
        sys.exit(1)
