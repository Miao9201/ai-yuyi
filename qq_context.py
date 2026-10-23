"""QQ memories are separate; imported persona material is read through an export-only view."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import qq_settings as qq
from companion_memory import Knowledge,media_options
from persona import load_profile,Persona


class ImportedKnowledge(Knowledge):
    def __init__(self,file):
        self.db=sqlite3.connect(Path(file).resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
        self.db.row_factory=sqlite3.Row
        try:
            # Shadow only this connection's reads, leaving the original database untouched.
            self.db.execute("CREATE TEMP VIEW memories AS SELECT * FROM main.memories WHERE origin='export'")
            self.db.execute('CREATE TEMP TABLE qq_export_ids(id TEXT PRIMARY KEY) WITHOUT ROWID')
            for row in self.db.execute('SELECT source_ids FROM memories'):
                self.db.executemany('INSERT OR IGNORE INTO qq_export_ids VALUES(?)',((str(v),) for v in json.loads(row[0])))
            self.db.execute('''CREATE TEMP VIEW pairs AS SELECT p.* FROM main.pairs p
              WHERE EXISTS(SELECT 1 FROM json_each(p.source_ids))
              AND NOT EXISTS(SELECT 1 FROM json_each(p.source_ids) j WHERE CAST(j.value AS TEXT) NOT IN (SELECT id FROM qq_export_ids))''')
        except BaseException:self.db.close();raise


def resolve_scope(bot,kind,peer,persona):
    qq.account(bot);qq.account(peer);qq.persona(persona)
    cfg=qq.load_config()
    if kind not in ('private','group') or peer not in cfg['privateUsers' if kind=='private' else 'groups']:raise ValueError('该QQ会话未开放')
    allowed=cfg['privatePersonas'].get(peer,cfg['persona']) if kind=='private' else cfg['groupPersona']
    if persona!=allowed:raise ValueError('该会话未开放这个人设')
    profile=load_profile(persona)
    if kind=='group' and (profile.get('real_chat_knowledge') or (qq.DATA.parent/'private'/persona/'persona.md').exists()):raise ValueError('群聊不使用私人资料')
    owner='qq:'+bot+':'+kind+':'+peer
    uid=owner+'::'+persona
    ident=hashlib.sha256(uid.encode('utf8')).hexdigest()[:32]
    return {'file':qq.DATA/'qq/memories'/(ident+'.sqlite3'),'directory':qq.DATA/'qq/runtime','owner':owner,'uid':uid,
            'account':'qq:'+bot+':'+kind+':'+peer,'persona':persona,'personaName':profile['name'],'label':'QQ '+('私聊 ' if kind=='private' else '群 ')+peer+' · '+profile['name'],'kind':kind,'peer':peer,'bot':bot}


def scopes():
    file=qq.DATA/'qq/state.json'
    try:bot=str(json.loads(file.read_text(encoding='utf8'))['bot'])
    except (OSError,ValueError,KeyError):return []
    cfg=qq.load_config();rows=[]
    for kind,targets in [('private',cfg['privateUsers']),('group',cfg['groups'])]:
        for peer in targets:
            name=cfg['privatePersonas'].get(peer,cfg['persona']) if kind=='private' else cfg['groupPersona']
            scope=resolve_scope(bot,kind,peer,name)
            rows.append({k:scope[k] for k in ('account','persona','personaName','label') }|{'ready':True})
    return rows


def scope_from_account(account,persona):
    parts=account.split(':')
    if len(parts)!=4 or parts[0]!='qq':raise ValueError('QQ会话标识无效')
    if not any(s['account']==account and s['persona']==persona for s in scopes()):raise ValueError('该QQ会话不可访问')
    return resolve_scope(parts[1],parts[2],parts[3],persona)


def context_for(request):
    scope=resolve_scope(str(request.get('bot','')),request.get('kind'),str(request.get('peer','')),request.get('persona',''))
    role=Persona(scope['persona']);profile=role.profile
    question=str(request.get('text',''))[:1200]
    scope['file'].parent.mkdir(parents=True,exist_ok=True)
    knowledge=Knowledge(scope['file'])
    try:
        knowledge.remember_live(scope['owner'],request.get('history',[]),'群友' if scope['kind']=='group' else '用户')
        memories=knowledge.search(question)
        facts=role.facts() if scope['kind']=='private' else (
            f'【当前QQ群角色】姓名：{profile["name"]}。群成员都是普通群友，按各自昵称称呼。'
            '本轮优先于人设中的私聊关系和历史错误称呼：只沿用角色的性格与口语风格，'
            '不要使用宝宝、老公、老婆等恋爱称呼，也不把任何群友当作私聊恋人。')
        parts=[facts,knowledge.fixed_context(),'【当前QQ会话已确认的对话记忆，不代表现实人物的真实经历】',*(m['text'] for m in memories)]
        if scope['kind']=='group':parts.append('当前是多人QQ群。请分清每位说话人，以群友身份自然接话，不把所有人当成私聊对象或恋人，不披露其他会话资料。')
        if profile.get('real_chat_knowledge'):
            folder=qq.DATA.parent/'private'/scope['persona']
            database=folder/'memory.sqlite3'
            if not database.exists():
                from companion_memory import DB
                if scope['persona']==load_profile().get('persona'):database=DB
            if database.exists():
                imported=ImportedKnowledge(database)
                try:parts.append(imported.reference(question))
                finally:imported.close()
            catalog=folder/'media-catalog.json'
        else:catalog=qq.DATA/profile['media_catalog'] if profile.get('media_catalog') else None
        result=media_options(question,request.get('history',[]),catalog) if catalog and catalog.exists() else {'candidates':[],'intent':None}
        result.update(context='\n'.join(p for p in parts if p),suppressed_history_keys=knowledge.history_exclusions(),evidence=[{'origin':m['origin'],'at':m['at'],'source_ids':m['source_ids']} for m in memories])
        return result
    finally:knowledge.close()


if __name__=='__main__':
    try:print(json.dumps(context_for(json.loads(sys.stdin.read())),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,ValueError) else 'QQ角色资料暂时不可用'},ensure_ascii=False));sys.exit(1)
