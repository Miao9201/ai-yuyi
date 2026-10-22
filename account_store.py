"""Local account registry and credential boundaries; never expose decrypted auth."""
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
from settings import DATA, protect, load_config

GUEST_PERSONAS={'linmuwan':'林慕婉'}


@contextmanager
def registry_lock():
    kernel=ctypes.windll.kernel32
    kernel.CreateMutexW.restype=ctypes.c_void_p
    name='Local\\ChatBotAccounts_'+hashlib.sha256(str(DATA.resolve()).encode()).hexdigest()[:16]
    handle=kernel.CreateMutexW(None,False,name)
    if not handle:raise OSError('无法锁定账号资料')
    try:
        result=kernel.WaitForSingleObject(ctypes.c_void_p(handle),10000)
        if result not in (0,128):raise OSError('账号资料正忙，请稍后重试')
        try:yield
        finally:kernel.ReleaseMutex(ctypes.c_void_p(handle))
    finally:kernel.CloseHandle(ctypes.c_void_p(handle))


def _id(value):
    if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{32}',value):raise ValueError('使用者 ID 无效')
    return value


def _label(value):
    if not isinstance(value,str) or not 1<=len(value.strip())<=80 or any(ord(c)<32 for c in value):raise ValueError('备注需要 1—80 个字符')
    return value.strip()


def _save(rows):
    DATA.mkdir(parents=True,exist_ok=True)
    file=DATA/'ilink-accounts.json';tmp=file.with_suffix('.tmp')
    tmp.write_text(json.dumps({'accounts':rows},ensure_ascii=False,indent=2),encoding='utf8');tmp.replace(file)


def load_accounts():
    file=DATA/'ilink-accounts.json'
    if not file.exists():return []
    raw=json.loads(file.read_text(encoding='utf8'));rows=raw['accounts']
    if not isinstance(rows,list):raise ValueError('账号列表格式错误')
    seen=set();result=[]
    for r in rows:
        ident=_id(r['id'])
        if ident in seen or r['persona'] not in GUEST_PERSONAS or type(r['enabled']) is not bool:raise ValueError('账号设定无效')
        seen.add(ident)
        result.append({'id':ident,'label':_label(r['label']),'persona':r['persona'],'enabled':r['enabled'],'revision':_id(r['revision']),'created_at':float(r['created_at'])})
    return result


def get_account(ident):
    _id(ident)
    for row in load_accounts():
        if row['id']==ident:return row
    raise ValueError('使用者不存在')


def account_dir(ident=''):
    if not ident:return DATA
    return DATA/'accounts'/get_account(ident)['id']


def assert_current_worker(ident):
    if ident:
        row=get_account(ident)
        if not row['enabled'] or row['revision']!=os.environ.get('WX_ILINK_ACCOUNT_REVISION'):raise ValueError('使用者授权版本已改变，请等待新连接')


def create_account(label):
    label=_label(label)
    with registry_lock():
        rows=load_accounts()
        row={'id':uuid.uuid4().hex,'label':label,'persona':'linmuwan','enabled':True,'revision':uuid.uuid4().hex,'created_at':time.time()}
        rows.append(row);_save(rows)
    return row


def _updated(ident,changes):
    if not isinstance(changes,dict) or set(changes)-{'label','persona','enabled'}:raise ValueError('更新字段无效')
    if 'label' in changes:changes={**changes,'label':_label(changes['label'])}
    if 'persona' in changes and changes['persona'] not in GUEST_PERSONAS:raise ValueError('该人设仅主账号可用，未开放给朋友')
    if 'enabled' in changes and type(changes['enabled']) is not bool:raise ValueError('启停必须是布尔值')
    rows=load_accounts();old=get_account(ident)
    new={**old,**changes,'revision':uuid.uuid4().hex}
    _save([new if r['id']==ident else r for r in rows]);return new


def update_account(ident,changes):
    with registry_lock():return _updated(ident,changes)


def reauthorize(ident):
    with registry_lock():
        row=_updated(ident,{'enabled':True})
        (account_dir(ident)/'ilink-auth.dpapi').unlink(missing_ok=True)
        return row


def delete_account(ident):
    with registry_lock():
        folder=account_dir(ident)
        # Revoke authorization and registration; retain history for deliberate local recovery.
        _save([row for row in load_accounts() if row['id']!=ident])
        (folder/'ilink-auth.dpapi').unlink(missing_ok=True)
    return {'removed':True}


def load_credential(ident=''):
    file=account_dir(ident)/'ilink-auth.dpapi'
    return json.loads(protect(file.read_bytes(),True).decode('utf8')) if file.exists() else None


def public_identity(ident=''):
    cred=load_credential(ident)
    if not cred or not cred.get('userId'):return {'bound':False,'name':'未绑定微信','source':'none'}
    for key in ('nickname','displayName'):
        name=cred.get(key)
        if isinstance(name,str) and name.strip() and len(name)<=80 and not any(ord(c)<32 for c in name):
            return {'bound':True,'name':name.strip(),'source':'nickname'}
    return {'bound':True,'name':cred['userId'],'source':'identifier'}


def save_credential(ident,data):
    if not isinstance(data,dict) or not all(isinstance(data.get(k),str) and data[k] for k in ('token','baseUrl','accountId','userId')):raise ValueError('授权资料不完整')
    with registry_lock():
        if os.environ.get('WX_ILINK_ACCOUNT_ID')==ident and ident:assert_current_worker(ident)
        folder=account_dir(ident)
        for other in ['']+[r['id'] for r in load_accounts()]:
            if other==ident:continue
            cred=load_credential(other)
            if cred and (cred.get('userId')==data['userId'] or cred.get('accountId')==data['accountId']):raise ValueError('这个微信已绑定其他使用者，请用朋友自己的微信扫码')
        folder.mkdir(parents=True,exist_ok=True)
        file=folder/'ilink-auth.dpapi';tmp=file.with_suffix('.tmp')
        tmp.write_bytes(protect(json.dumps(data).encode('utf8')));tmp.replace(file)


def guard_persona(persona):
    ident=os.environ.get('WX_ILINK_ACCOUNT_ID','')
    if ident:
        row=get_account(ident)
        if not row['enabled'] or persona not in GUEST_PERSONAS or persona!=row['persona']:raise ValueError('该使用者不能访问这个人设')
    return persona


def account_status(ident=''):
    row=get_account(ident) if ident else None
    try:status=json.loads((account_dir(ident)/'status.json').read_text(encoding='utf8'))
    except (OSError,ValueError):status={'state':'starting','detail':'等待启动连接'}
    cfg=load_config()
    if row and not row['enabled']:return {'state':'disabled','detail':'已暂停，聊天记录保留'}
    if not cfg.get('enabled'):return {'state':'stopped','detail':'全局回复已停止'}
    if row and (status.get('accountRevision')!=row['revision'] or status.get('runId')!=cfg.get('run_id')):return {'state':'starting','detail':'正在更新使用者连接'}
    allowed=('state','detail','at','qr','qrVersion','expiresAt','accountRevision','runId')
    return {k:status[k] for k in allowed if k in status}


def qr_available(ident):
    s=account_status(ident)
    return s.get('state')=='awaiting_scan' and s.get('qr') is True and s.get('expiresAt',0)>time.time()*1000 and (account_dir(ident)/'ilink-qr.png').is_file()


def public_accounts():
    cfg_file=DATA.parent/'upstream-v1.2.0/data/config.json'
    try:persona=json.loads(cfg_file.read_text(encoding='utf8')).get('defaultPersona','private_persona')
    except (OSError,ValueError):persona='private_persona'
    rows=[{'id':'','label':'我（主账号）','persona':persona,'enabled':bool(load_config().get('enabled')),'primary':True,'status':account_status()}]
    rows.extend({**r,'primary':False,'status':account_status(r['id'])} for r in load_accounts())
    return {'accounts':rows,'personas':[{'id':k,'name':v} for k,v in GUEST_PERSONAS.items()]}


def main():
    action=sys.argv[1];body=json.loads(sys.stdin.read() or '{}')
    if action=='list':result=public_accounts()
    elif action=='identity':result=public_identity()
    elif action=='create':result=create_account(body.get('label'))
    elif action=='update':result=update_account(body.get('id'),body.get('changes'))
    elif action=='reauthorize':result=reauthorize(body.get('id'))
    elif action=='delete':result=delete_account(body.get('id'))
    elif action=='qr':
        ident=body.get('id')
        if not qr_available(ident):raise ValueError('当前没有有效二维码，请刷新状态')
        result={'file':str(account_dir(ident)/'ilink-qr.png')}
    else:raise ValueError('未知操作')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except Exception as exc:
        print(json.dumps({'error':str(exc) if isinstance(exc,ValueError) else '账号资料操作失败'},ensure_ascii=False));sys.exit(1)
