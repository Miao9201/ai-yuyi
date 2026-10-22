"""Import user-owned JSON into a new local-only persona; original export is never changed."""
import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import uuid
from settings import DATA
from companion_memory import Knowledge,clean_messages,collect_media


def read_export(source):
    source=Path(source).expanduser().resolve(strict=True)
    if not source.is_file() or source.suffix.lower()!='.json' or source.stat().st_size>200*1024*1024:
        raise ValueError('请选择不超过200MB的JSON文件')
    raw=json.loads(source.read_text(encoding='utf-8-sig'))
    rows=raw.get('messages') if isinstance(raw,dict) else raw
    if not isinstance(rows,list) or not rows or any(not isinstance(m,dict) for m in rows):
        raise ValueError('JSON需要是消息数组，或包含messages数组')
    return source,rows


def analyze(source):
    _,messages=read_export(source)
    counts=Counter(m.get('sender_id') for m in messages if isinstance(m.get('sender_id'),str) and m['sender_id'] and m.get('category')!='system')
    names={m['sender_id']:str(m.get('sender_name') or m['sender_id'])[:80] for m in messages if m.get('sender_id') in counts}
    return {'messages':len(messages),'participants':[{'id':ident,'name':names[ident],'count':count} for ident,count in counts.most_common()]}


def label(value,default):
    value=str(value or default).strip()
    if not value or len(value)>80 or any(ord(c)<32 for c in value):raise ValueError('名称需要1—80个可见字符')
    return value


def import_persona(body):
    source,messages=read_export(body.get('source',''))
    target=body.get('target');owner=body.get('self')
    senders={m.get('sender_id') for m in messages if isinstance(m.get('sender_id'),str)}
    if not isinstance(target,str) or target not in senders or owner not in senders or owner==target:
        raise ValueError('请选择两个不同的记录参与者，分别作为模仿对象和你自己')
    names={m['sender_id']:m.get('sender_name') for m in messages if m.get('sender_id') in (target,owner)}
    title=label(body.get('name'),names.get(target) or '自定义角色')
    address=label(body.get('address'),names.get(owner) or '用户')
    if title==address:raise ValueError('两位说话人的显示名称不能相同')
    relationship=label(body.get('relationship'),'按用户设定')
    gender=label(body.get('gender'),'按用户设定')
    persona=body.get('persona') or 'imported_'+uuid.uuid4().hex[:12]
    if not isinstance(persona,str) or not re.fullmatch('[a-z][a-z0-9_-]{0,31}',persona):raise ValueError('人设ID只能包含小写字母、数字、短横线和下划线')
    private=DATA.parent/'private';private.mkdir(parents=True,exist_ok=True)
    destination=private/persona
    if destination.exists() or (DATA.parent/'upstream-v1.2.0/personas'/(persona+'.md')).exists():
        raise ValueError('人设ID已存在，请使用新ID；导入不会覆盖现有记录')
    rows=clean_messages(messages,target,owner,title,address)
    if not rows or not any(r['role']==title for r in rows):raise ValueError('没有可用于学习的有效文字记录')
    years=[int(r['at'][:4]) for r in rows if re.match(r'^20\d{2}',r['at'])]
    focus_year=max(years)-1 if years else datetime.now().year-1
    stage=Path(tempfile.mkdtemp(prefix='.importing-',dir=private))
    try:
        k=Knowledge(stage/'memory.sqlite3')
        try:
            style=k.import_records(rows,title,address,focus_year)
            style.update(target_name=title,self_name=address,focus_year=focus_year)
            k.db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',('style',json.dumps(style,ensure_ascii=False)))
            k.db.commit()
            counts={t:k.db.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ('memories','pairs')}
            examples=[{'user':r['question'],'assistant':r['answer']} for r in k.db.execute('SELECT question,answer FROM pairs ORDER BY at DESC LIMIT 3000')]
        finally:k.close()
        media=collect_media(messages,source.parent,target,owner,title,address)
        for item in media:
            item.update(allowed=body.get('allow_media') is True,safe_auto=False)
        profile={'name':title,'gender':gender,'relationship':relationship,'address':address,'real_chat_knowledge':True,'media_catalog':'media-catalog.json'}
        report={'source_messages':len(messages),'indexed_messages':len(rows),**counts,'focus_year':focus_year,'emoji_assets':sum(i['kind']=='emoji' for i in media),'image_assets':sum(i['kind']=='image' for i in media)}
        files={'profile.json':profile,'style-examples.json':{'summary':style,'examples':examples},'import-report.json':report,
               'media-catalog.json':{'source_root':str(source.parent),'source_file':str(source),'media_subdir':'media','items':media}}
        for name,data in files.items():(stage/name).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
        (stage/'persona.md').write_text('---\ntitle: '+title+'\ndescription: 使用用户本地导入资料的风格模拟\n---\n\n这是AI风格模拟。身份、关系和称呼以用户设定为准；只从参考记录学习表达，不编造共同经历。\n',encoding='utf-8')
        stage.rename(destination)
        return {'persona':persona,'name':title,**report,'mediaEnabled':body.get('allow_media') is True}
    finally:
        if stage.exists():shutil.rmtree(stage)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('analyze','import'))
    parser.add_argument('--source');parser.add_argument('--target');parser.add_argument('--self',dest='owner');parser.add_argument('--persona');parser.add_argument('--name');parser.add_argument('--address');parser.add_argument('--relationship');parser.add_argument('--gender');parser.add_argument('--allow-media',action='store_true')
    args=parser.parse_args()
    body={'source':args.source,'target':args.target,'self':args.owner,'persona':args.persona,'name':args.name,'address':args.address,'relationship':args.relationship,'gender':args.gender,'allow_media':args.allow_media} if args.source else json.loads(sys.stdin.read() or '{}')
    result=analyze(body.get('source','')) if args.action=='analyze' else import_persona(body)
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except Exception as exc:
        print(json.dumps({'error':str(exc) if isinstance(exc,ValueError) and not isinstance(exc,json.JSONDecodeError) else '导入失败，请检查JSON格式、路径和读取权限'},ensure_ascii=False));sys.exit(1)
