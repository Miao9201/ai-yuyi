"""Administrator memory access, scoped by validated account and persona."""
import hashlib
import json
import re
import sys
from account_store import load_accounts,load_credential,GUEST_PERSONAS
from companion_memory import Knowledge,memory_path
from memory_editing import MemoryConflict
from settings import DATA


def scopes():
    from persona import load_profile
    names={p.stem for p in (DATA.parent/'upstream-v1.2.0/personas').glob('*.md') if re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}',p.stem)}
    names.update(p.name for p in (DATA.parent/'private').glob('*') if p.is_dir() and (p/'persona.md').exists())
    rows=[]
    connected=bool(load_credential())
    for name in sorted(names):
        profile=load_profile(name)
        rows.append({'account':'','persona':name,'personaName':profile['name'],'label':'我 · '+profile['name'],'ready':connected or bool(profile.get('real_chat_knowledge'))})
    rows.extend({'account':a['id'],'persona':a['persona'],'personaName':GUEST_PERSONAS[a['persona']],'label':a['label']+' · '+GUEST_PERSONAS[a['persona']],'ready':bool(load_credential(a['id']))} for a in load_accounts())
    from qq_context import scopes as qq_scopes
    try:rows.extend(qq_scopes())
    except (OSError,ValueError):pass # A damaged QQ setting must not hide WeChat memories.
    return {'scopes':rows}


def resolve_scope(account,persona):
    if not isinstance(account,str) or not isinstance(persona,str):raise ValueError('请选择用户和人设')
    if account.startswith('qq:'):
        from qq_context import scope_from_account
        return scope_from_account(account,persona)
    match=next((s for s in scopes()['scopes'] if s['account']==account and s['persona']==persona),None)
    if not match:raise ValueError('该用户不能访问这个人设的记忆')
    if not match['ready']:raise ValueError('这位用户尚未扫码连接，暂时没有独立记忆库')
    cred=load_credential(account);user=cred['userId'] if cred else ''
    ident=hashlib.sha256(user.encode()).hexdigest()[:16];owner=('account:'+account+'::' if account else '')+ident
    directory=DATA/'accounts'/account/'runtime' if account else DATA.parent/'upstream-v1.2.0/data'
    uid=('account:'+account+'::' if account else '')+user+'::'+persona
    return {'file':memory_path(persona,owner,data=DATA),'label':match['label'],'directory':directory,'uid':uid}


def execute(action,body):
    if action=='scopes':return scopes()
    scope=resolve_scope(body.get('account',''),body.get('persona',''))
    if action=='topics':
        try:topics=json.loads((scope['directory']/'topics.json').read_text(encoding='utf8'))
        except (OSError,ValueError):topics={}
        bucket=topics.get(scope['uid'],{})
        return {'label':scope['label'],'history':bucket.get('history',[]),'bans':bucket.get('bans',[])}
    kind=body.get('kind','memories')
    if kind!='memories' or body.get('origin','all') not in ('all','live','manual'):
        raise ValueError('这里只管理 AI 对话和手动补充')
    scope['file'].parent.mkdir(parents=True,exist_ok=True);knowledge=Knowledge(scope['file'])
    try:
        if action=='list':return {**knowledge.editor_list(kind,query=body.get('query',''),origin=body.get('origin','all'),status=body.get('status','active'),offset=body.get('offset',0),limit=20,local_only=True),'label':scope['label']}
        if action in ('change','undo') and knowledge.editor_row(kind,body.get('id'))['origin'] not in ('live','manual'):
            raise ValueError('导入资料不在记忆管理中编辑')
        if action=='add':row=knowledge.editor_add(body.get('text'),body.get('pinned',False))
        elif action=='change':row=knowledge.editor_change(kind,body.get('id'),body.get('revision'),body.get('changes'))
        elif action=='undo':row=knowledge.editor_undo(kind,body.get('id'),body.get('revision'),body.get('audit_id'))
        else:raise ValueError('未知记忆操作')
        return {'entry':row}
    finally:knowledge.close()


if __name__=='__main__':
    try:print(json.dumps(execute(sys.argv[1],json.loads(sys.stdin.read() or '{}')),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,ValueError) else '记忆库暂时不可用，请稍后重试','status':409 if isinstance(error,MemoryConflict) else 400},ensure_ascii=False));sys.exit(1)
