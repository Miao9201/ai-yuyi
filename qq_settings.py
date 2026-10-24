"""Local QQ settings; no credentials are returned to the management UI."""
import json
import math
import re
import secrets
import sys
from urllib.parse import urlsplit
from settings import DATA,atomic_write,protect

DEFAULTS={'enabled':False,'wechatEnabled':True,'privateUsers':[],'groups':[],
          'persona':'dafeiyu','groupPersona':'dafeiyu','groupFollowsDefault':True,'privatePersonas':{},
          'wsUrl':'ws://127.0.0.1:3001/','probability':0.1,'cooldownSeconds':5,
          'maxPerMinute':6,'keywords':['DeepSeek','deepseek','大肥鱼','肥鱼','小鲸鱼'],'quietHours':[0,7],
          'activeHours':[0,24],'activeHourSlots':None,'emotionAware':True,
          'replyOptions':{'visionEnabled':True,'sceneEnabled':True,'emotionEnabled':True}}


def account(value):
    if not isinstance(value,str) or not re.fullmatch(r'[1-9][0-9]{4,11}',value):raise ValueError('QQ或群号应为5到12位数字')
    return value


def persona(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}',value):raise ValueError('人设名称无效')
    return value


def validate(cfg):
    if set(cfg)!=set(DEFAULTS):raise ValueError('QQ配置包含未知字段')
    for name in ('enabled','wechatEnabled','emotionAware','groupFollowsDefault'):
        if type(cfg[name]) is not bool:raise ValueError('启用状态应为布尔值')
    for name in ('privateUsers','groups'):
        if not isinstance(cfg[name],list) or len(cfg[name])>200:raise ValueError('允许对象最多200个')
        cfg[name]=list(dict.fromkeys(account(v) for v in cfg[name]))
    persona(cfg['persona'])
    persona(cfg['groupPersona'])
    mapping=cfg['privatePersonas']
    if not isinstance(mapping,dict) or set(mapping)-set(cfg['privateUsers']):raise ValueError('只能给允许的私聊对象指定人设')
    for value in mapping.values():persona(value)
    raw=cfg['wsUrl']
    if not isinstance(raw,str) or len(raw)>200:raise ValueError('OneBot地址无效')
    try:
        url=urlsplit(raw)
        if url.scheme!='ws' or url.hostname!='127.0.0.1' or not url.port or url.path not in ('','/') or url.query or url.fragment or url.username or url.password:raise ValueError()
    except ValueError:raise ValueError('OneBot仅允许本机127.0.0.1地址，不要在地址填写令牌') from None
    for name,minimum,maximum in [('probability',0,1),('cooldownSeconds',0,300),('maxPerMinute',1,60)]:
        value=cfg[name]
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not minimum<=value<=maximum:raise ValueError('接话概率、冷却或频率参数无效')
        if name=='maxPerMinute' and type(value) is not int:raise ValueError('每分钟回复上限应为整数')
    if not isinstance(cfg['keywords'],list) or len(cfg['keywords'])>20 or any(not isinstance(v,str) or not 1<=len(v.strip())<=30 or any(ord(c)<32 for c in v) for v in cfg['keywords']):raise ValueError('触发词最多20个，每个1到30字')
    for key in ('quietHours','activeHours'):
        hours=cfg[key]
        if not isinstance(hours,list) or len(hours)!=2 or any(type(v) is not int or not 0<=v<=24 for v in hours):raise ValueError('时段应为两个0到24的整数')
    slots=cfg['activeHourSlots']
    if slots is not None:
        if not isinstance(slots,list) or len(slots)>24 or any(type(v) is not int or not 0<=v<24 for v in slots) or len(set(slots))!=len(slots):raise ValueError('活跃时间格应为不重复的0到23整数')
        cfg['activeHourSlots']=sorted(slots)
    options=cfg['replyOptions']
    if not isinstance(options,dict) or set(options)!=set(DEFAULTS['replyOptions']) or any(type(v) is not bool for v in options.values()):raise ValueError('QQ回复参数无效')
    return cfg


def load_config():
    file=DATA/'qq/settings.json'
    raw=json.loads(file.read_text(encoding='utf8')) if file.exists() else {}
    cfg={**DEFAULTS,**raw}
    if 'groupFollowsDefault' not in raw:cfg['groupFollowsDefault']=cfg['persona']==cfg['groupPersona']
    return validate(json.loads(json.dumps(cfg)))


def public_config():
    cfg=load_config()
    return {**cfg,'hasConnectionToken':(DATA/'qq/connection.dpapi').is_file()}


def save_config(body):
    if not isinstance(body,dict) or set(body)-set(DEFAULTS):raise ValueError('QQ配置字段无效')
    cfg={**load_config(),**body}
    if 'groupPersona' in body and 'groupFollowsDefault' not in body:cfg['groupFollowsDefault']=cfg['groupPersona']==cfg['persona']
    if cfg['groupFollowsDefault']:cfg['groupPersona']=cfg['persona']
    if set(body)&{'persona','groupPersona','groupFollowsDefault'}:
        group=persona(cfg['groupPersona'])
        from persona import load_profile
        if (DATA.parent/'private'/group).exists() or load_profile(group).get('real_chat_knowledge'):raise ValueError('私密人设只能用于私聊，请给群聊单独选择公开人设')
        if group not in ('linmuwan','dafeiyu'):
            if not (DATA.parent/'upstream-v1.2.0/personas'/f'{group}.md').is_file():raise ValueError('群聊人设不存在')
    if 'privateUsers' in body and 'privatePersonas' not in body and isinstance(cfg['privateUsers'],list):
        cfg['privatePersonas']={peer:role for peer,role in cfg['privatePersonas'].items() if peer in cfg['privateUsers']}
    cfg=validate(cfg)
    atomic_write(DATA/'qq/settings.json',json.dumps(cfg,ensure_ascii=False,indent=2).encode('utf8'))
    return public_config()


def connection_settings():
    file=DATA/'qq/connection.dpapi'
    if not file.exists():atomic_write(file,protect(secrets.token_urlsafe(32).encode('ascii')))
    token=protect(file.read_bytes(),True).decode('ascii')
    return {'url':load_config()['wsUrl'],'token':token}


if __name__=='__main__':
    try:
        action=sys.argv[1] if len(sys.argv)==2 else ''
        if action=='get':result=public_config()
        elif action=='save':
            body=json.loads(sys.stdin.read(65537))
            if not isinstance(body,dict) or 'wechatEnabled' in body:raise ValueError('请在微信板块调整微信开关')
            result=save_config(body)
        elif action=='wechat-get':result={'enabled':load_config()['wechatEnabled'],'groupSupported':False}
        elif action=='wechat-save':
            body=json.loads(sys.stdin.read(65537))
            if not isinstance(body,dict) or set(body)!={'enabled'} or type(body['enabled']) is not bool:raise ValueError('微信平台设置无效')
            result={'enabled':save_config({'wechatEnabled':body['enabled']})['wechatEnabled'],'groupSupported':False}
        elif action=='connection':result=connection_settings() # Private child-process stdio only.
        else:raise ValueError('QQ设置操作无效')
        print(json.dumps(result,ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,ValueError) else '本机QQ配置暂时不可用','status':400},ensure_ascii=False));sys.exit(1)
