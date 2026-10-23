"""QQ child lifecycle is independent from the WeChat workers."""
import json
import os
import subprocess
import time
from settings import ROOT,DATA,atomic_write
from runtime_paths import node_executable

def stop_child(proc):
    if proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()

class QQWorker:
    def __init__(self,spawn,on_error=lambda:None):
        self.spawn=spawn;self.on_error=on_error;self.proc=None;self.retry=0
    def reconcile(self,enabled):
        if not enabled:
            if self.proc:stop_child(self.proc);self.proc=None
            return
        if self.proc and self.proc.poll() is not None:self.proc=None;self.retry=time.monotonic()+10
        if self.proc is not None or time.monotonic()<self.retry:return
        try:self.proc=self.spawn()
        except Exception:
            self.retry=time.monotonic()+10
            try:self.on_error()
            except Exception:pass
    def close(self):self.reconcile(False)

def spawn_worker(env):
    import qq_runtime
    qq_runtime.start()
    folder=DATA/'qq';folder.mkdir(parents=True,exist_ok=True)
    child_env={**env,'YUYI_QQ_MEDIA_ROOTS':json.dumps([str(qq_runtime.paths()['core']/'cache')])}
    with (folder/'run.log').open('a',encoding='utf8') as log:
        return subprocess.Popen([node_executable(),str(ROOT/'upstream-v1.2.0/qq-runtime.mjs')],cwd=ROOT/'upstream-v1.2.0',env=child_env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)

def error_state():
    file=DATA/'qq/state.json'
    try:state=json.loads(file.read_text(encoding='utf8'))
    except (OSError,ValueError):state={}
    state.update(state='error',detail='QQ暂时不可用，10秒后重试；微信继续运行',at=time.time())
    atomic_write(file,json.dumps(state,ensure_ascii=False).encode('utf8'))
