from runtime_paths import node_executable
"""Private stdio bridge into the actual v1.2.0 reply handler."""
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
import uuid
from settings import ROOT,load_key

UPSTREAM=ROOT/'upstream-v1.2.0'


class V12Bridge:
    def __init__(self,project=UPSTREAM,api_key=None,preload=None):
        self.project=Path(project);self.pending=None;self.messages=queue.Queue()
        env=os.environ.copy();env['DEEPSEEK_API_KEY']=load_key() if api_key is None else api_key
        command=[node_executable()]
        if preload:command+=['--import',Path(preload).resolve().as_uri()]
        command += [str(self.project/'desktop-transport.mjs'),'--mode=chat','--desktop-transport']
        self.log=(self.project/'data'/'run.log').open('a',encoding='utf-8')
        self.proc=subprocess.Popen(command,cwd=self.project,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
        def read():
            for line in self.proc.stdout:self.messages.put(line)
            self.messages.put('{"type":"error","error":"新版对话进程已退出"}')
        threading.Thread(target=read,daemon=True).start()
        try:
            ready=self._receive(20)
            if ready.get('type')!='ready':raise RuntimeError('新版对话引擎未就绪')
            self.features=ready['features']
        except Exception:
            self.close();raise

    def _receive(self,timeout=75,cancelled=None):
        deadline=time.monotonic()+timeout
        while True:
            if cancelled and cancelled():raise RuntimeError('已停止，本轮生成已取消')
            remaining=deadline-time.monotonic()
            if remaining<=0:raise RuntimeError('新版对话引擎响应超时')
            try:result=json.loads(self.messages.get(timeout=min(.2,remaining)));break
            except queue.Empty:continue
        if result.get('type')=='error':raise RuntimeError(result.get('error','新版引擎失败'))
        return result

    def _send(self,payload):
        self.proc.stdin.write(json.dumps(payload,ensure_ascii=False)+'\n');self.proc.stdin.flush()

    def seed(self,history):
        self._send({'op':'seed','id':uuid.uuid4().hex,'history':history})
        self._receive()

    def sync(self,history):
        current=uuid.uuid4().hex
        self._send({'op':'sync','id':current,'history':history})
        result=self._receive()
        if result.get('type')!='done' or result.get('id')!=current:raise RuntimeError('新版确认历史同步失败')

    def generate(self,text,context,cancelled=None):
        self.pending=uuid.uuid4().hex
        self._send({'op':'generate','id':self.pending,'text':text,'context':context})
        try:
            result=self._receive(cancelled=cancelled) if cancelled else self._receive()
            if result.get('type')!='prepared' or result.get('id')!=self.pending:raise RuntimeError('新版引擎返回了非预期结果')
            answer='\n\n'.join(result.get('bubbles',[])).strip()
            if not answer or len(answer)>500:raise RuntimeError('新版回复为空或过长')
            return answer
        except Exception:
            # Do not leave a late prepared reply waiting for an ack after a timeout.
            self.pending=None
            self.close()
            raise

    def commit(self,success):
        if self.pending is None:return
        current=self.pending;self.pending=None
        self._send({'op':'ack','id':current,'ok':bool(success)})
        result=self._receive()
        if result.get('id')!=current or result.get('type')!=('done' if success else 'aborted'):
            raise RuntimeError('新版对话记忆确认失败')

    def close(self):
        if self.pending:
            try:self.commit(False)
            except Exception:pass
        if self.proc.poll() is None:
            self.proc.terminate()
            try:self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait()
        self.proc.stdin.close();self.proc.stdout.close();self.log.close()
