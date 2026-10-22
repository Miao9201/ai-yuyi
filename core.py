"""Local OCR parsing, fail-closed routing and durable message state."""
import json
import re
import sqlite3
import time
import unicodedata
import numpy as np


def contains_credential(text):
    return bool(re.search(r'\bsk\s*[-−—]\s*\S',str(text),re.IGNORECASE))


def completion_text(payload):
    try:
        content=payload['choices'][0]['message']['content']
    except (TypeError,KeyError,IndexError):
        raise RuntimeError('模型响应格式不完整') from None
    if not isinstance(content,str) or not content.strip() or len(content.strip())>500:
        raise RuntimeError('模型回复为空或过长')
    return content.strip()


def text_key(text):
    s=unicodedata.normalize('NFKC',str(text))
    plain=''.join(c for c in s if unicodedata.category(c)[0] in ('L','N'))
    return plain or re.sub(r'\s+','',s)


def screen_equal(a,b):
    return [text_key(s) for s in a]==[text_key(s) for s in b]


def normalize_ocr(text):
    text = re.sub(r'\s+', ' ', str(text)).strip()
    return re.sub(r'(?<=[\u3400-\u9fff]) | (?=[\u3400-\u9fff])', '', text)


def ocr_reading_order(lines):
    rows=[]
    for line in sorted(lines,key=lambda item:item['words'][0]['y']+item['words'][0]['h']/2):
        word=line['words'][0];cy=word['y']+word['h']/2
        if not rows or abs(cy-rows[-1]['cy'])>min(word['h'],rows[-1]['height'])*.5:
            rows.append({'cy':cy,'height':word['h'],'lines':[line]})
        else:
            row=rows[-1];count=len(row['lines'])
            row['cy']=(row['cy']*count+cy)/(count+1)
            row['height']=min(row['height'],word['h']);row['lines'].append(line)
    return [line for row in rows for line in sorted(row['lines'],key=lambda item:item['words'][0]['x'])]


def new_messages(previous, current):
    # An unrecognisable screen is a new baseline, never permission to replay it.
    if not current:
        return []
    if not previous:
        return current
    for overlap in range(min(len(previous), len(current)), 0, -1):
        if screen_equal(previous[-overlap:],current[:overlap]):
            return current[overlap:]
    return []


def incoming_question(items):
    parts=[]
    for item in items:
        if item.startswith('in:'):parts.append(item[3:])
        elif item=='media:in':parts.append('[图片或表情：内容不可识别]')
    return '\n'.join(parts)[-1200:]


def snapshot_compatible(previous,current):
    if not previous:
        return True
    if not current:
        return False
    for overlap in range(min(len(previous),len(current)),0,-1):
        if screen_equal(previous[-overlap:],current[:overlap]):
            return len(current)>=len(previous) or len(current)>overlap or any(s.startswith('media:') for s in current)
    # A tall media message may replace the whole viewport. new_messages still
    # returns nothing without overlap, so this only adopts a baseline, never replays.
    return any(s.startswith('media:') for s in current)


def find_avatars(image):
    a=np.asarray(image.convert('RGB')).astype(np.int16)
    result=[]
    for direction,left,right in [('in',18,54),('out',image.width-40,image.width-4)]:
        strip=a[:,left:right]
        ink=(np.abs(strip-249).max(axis=2)>24).sum(axis=1)>=12
        rows=np.flatnonzero(ink)
        for group in np.split(rows,np.where(np.diff(rows)>3)[0]+1):
            if len(group) and 18<=group[-1]-group[0]+1<=44:
                result.append({'direction':direction,'top':int(group[0])})
    return result


def title_matches(reference,current):
    a=np.asarray(reference.convert('L'))<150
    b=np.asarray(current.convert('L'))<150
    if a.shape!=b.shape or int(a.sum())<16 or int(b.sum())<16:return False
    union=int((a|b).sum())
    return bool(union and int((a&b).sum())/union>=.94)


def find_bubbles(image):
    a = np.asarray(image.convert('RGB'))
    result = []
    h, w = a.shape[:2]
    if w < 150 or h < 30:
        return result
    # Avatars sit outside this strip; current 4.1.15 uses light-grey incoming bubbles.
    for direction in ('in', 'out'):
        if direction == 'in':
            white=(a[:,:,0] >= 253) & (a[:,:,1] >= 253) & (a[:,:,2] >= 253)
            grey=(a.min(axis=2)>=233) & (a.max(axis=2)<=243) & ((a.max(axis=2)-a.min(axis=2))<=5)
            mask=white | grey
        else:
            mask = (a[:,:,0] >= 80) & (a[:,:,0] <= 190) & (a[:,:,1] >= 185) & (a[:,:,2] >= 55) & (a[:,:,2] <= 175)
        mask[:,:50] = False
        mask[:,w-50:] = False
        ys = np.flatnonzero(mask.sum(axis=1) >= 24)
        if not len(ys):
            continue
        groups = np.split(ys, np.where(np.diff(ys) > 4)[0]+1)
        for rows in groups:
            top, bottom = int(rows[0]), int(rows[-1])+1
            if bottom-top < 18:
                continue
            xx = np.flatnonzero(mask[top:bottom].sum(axis=0) >= min(8, bottom-top//2))
            if not len(xx):
                continue
            left, right = int(xx[0]), int(xx[-1])+1
            # Inbound bubbles must originate at the known left message column.
            if direction == 'in' and left > 90:
                continue
            result.append({'direction':direction, 'box':(left,top,right,bottom)})
    return sorted(result, key=lambda b:b['box'][1])


def send_guard(actual_title, expected_title, foreground, geometry_ok, unchanged):
    return bool(expected_title and actual_title == expected_title and foreground and geometry_ok and unchanged)


class State:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at REAL, message TEXT, status TEXT, answer TEXT)')
        self.db.execute("CREATE TABLE IF NOT EXISTS deliveries (event INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, phase TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at REAL NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')")
        self.db.commit()

    def snapshot(self):
        row = self.db.execute("SELECT v FROM kv WHERE k='snapshot'").fetchone()
        return json.loads(row[0]) if row else []

    def save_snapshot(self, items):
        self.db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)', ('snapshot',json.dumps(items,ensure_ascii=False)))
        self.db.commit()

    def startup_baseline(self, items):
        persisted=self.snapshot()
        fresh=new_messages(persisted,items) if persisted else []
        if incoming_question(fresh) and not any(s.startswith('out:') or s=='media:out' for s in fresh):
            return persisted
        row=self.db.execute("SELECT id,message,answer FROM events WHERE status='sent' ORDER BY id DESC LIMIT 1").fetchone()
        if not row or self.db.execute('SELECT 1 FROM events WHERE id>? LIMIT 1',(row[0],)).fetchone():return items
        outgoing=[i for i,item in enumerate(items) if item.startswith('out:')]
        if not outgoing:return items
        last=outgoing[-1]
        if not incoming_question(items[last+1:]) or text_key(items[last][4:])!=text_key(row[2]):return items
        before=outgoing[-2]+1 if len(outgoing)>1 else 0
        question=incoming_question(items[before:last])
        if text_key(question)!=text_key(row[1].removeprefix('in:')):return items
        return items[:last+1]

    def reserve(self, message, snapshot):
        cur = self.db.execute('INSERT INTO events(at,message,status,answer) VALUES (?,?,?,?)', (time.time(),message,'reserved',''))
        self.db.execute('INSERT INTO deliveries(event,snapshot,phase) VALUES (?,?,?)',(cur.lastrowid,json.dumps(snapshot,ensure_ascii=False),'queued'))
        self.db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)', ('snapshot',json.dumps(snapshot,ensure_ascii=False)))
        self.db.commit()
        return cur.lastrowid

    def finish(self, event, status, answer=''):
        self.db.execute('UPDATE events SET status=?,answer=? WHERE id=?', (status,answer,event))
        phase={'sent':'confirmed','sending':'entering','reserved':'queued'}.get(status,status)
        self.db.execute('UPDATE deliveries SET phase=? WHERE event=?',(phase,event))
        self.db.commit()

    def recover_deliveries(self):
        self.db.execute("UPDATE events SET status='uncertain' WHERE id IN (SELECT event FROM deliveries WHERE phase='entering')")
        self.db.execute("UPDATE deliveries SET phase='uncertain',error='上次在发送阶段退出，等待屏幕确认，不自动重发' WHERE phase='entering'")
        self.db.execute("UPDATE deliveries SET phase='queued' WHERE phase='generating'")
        self.db.commit()

    def delivery(self):
        row=self.db.execute("SELECT e.id,e.message,e.answer,d.snapshot,d.phase,d.attempts,d.retry_at,d.error FROM deliveries d JOIN events e ON e.id=d.event WHERE d.phase IN ('queued','generating','prepared','pasting','pasted') ORDER BY e.id LIMIT 1").fetchone()
        if not row:return None
        job=dict(zip(('id','message','answer','snapshot','phase','attempts','retry_at','error'),row))
        job['snapshot']=json.loads(job['snapshot']);return job

    def save_reply(self,event,answer):
        self.db.execute("UPDATE events SET status='prepared',answer=? WHERE id=?",(answer,event))
        self.db.execute("UPDATE deliveries SET phase='prepared',attempts=0,retry_at=0,error='' WHERE event=?",(event,));self.db.commit()

    def set_phase(self,event,phase):
        if phase not in ('queued','generating','prepared','pasting','pasted','entering'):raise ValueError('无效发送阶段')
        self.db.execute('UPDATE deliveries SET phase=? WHERE event=?',(phase,event))
        if phase=='entering':self.db.execute("UPDATE events SET status='sending' WHERE id=?",(event,))
        self.db.commit()

    def merge_delivery(self,event,additional,snapshot):
        self.db.execute("UPDATE events SET message=message||char(10)||?,answer='',status='reserved' WHERE id=?",(additional,event))
        self.db.execute("UPDATE deliveries SET snapshot=?,phase='queued',attempts=0,retry_at=0,error='' WHERE event=?",(json.dumps(snapshot,ensure_ascii=False),event))
        self.db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)',('snapshot',json.dumps(snapshot,ensure_ascii=False)));self.db.commit()

    def checkpoint_delivery(self,event,snapshot):
        raw=json.dumps(snapshot,ensure_ascii=False)
        self.db.execute('UPDATE deliveries SET snapshot=? WHERE event=?',(raw,event))
        self.db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)',('snapshot',raw));self.db.commit()

    def defer_delivery(self,event,error,delay,model_error=False):
        row=self.db.execute('SELECT phase,attempts FROM deliveries WHERE event=?',(event,)).fetchone()
        attempts=row[1]+int(model_error);failed=model_error and attempts>=3
        phase='failed' if failed else ('queued' if model_error else ('pasted' if row[0]=='entering' else row[0]))
        self.db.execute('UPDATE deliveries SET phase=?,attempts=?,retry_at=?,error=? WHERE event=?',(phase,attempts,time.time()+delay,str(error)[:220],event))
        self.db.execute('UPDATE events SET status=? WHERE id=?',('failed' if failed else ('prepared' if phase in ('prepared','pasting','pasted') else 'reserved'),event));self.db.commit()
        return not failed

    def complete_delivery(self,event,snapshot):
        self.db.execute("UPDATE events SET status='sent' WHERE id=?",(event,))
        self.db.execute("UPDATE deliveries SET phase='confirmed',error='' WHERE event=?",(event,))
        self.db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)',('snapshot',json.dumps(snapshot,ensure_ascii=False)));self.db.commit()

    def confirm_visible(self,items):
        confirmed=[]
        rows=self.db.execute("SELECT e.id,e.message,e.answer,d.snapshot FROM events e JOIN deliveries d ON e.id=d.event WHERE d.phase IN ('uncertain','entering') AND e.answer!='' ORDER BY e.id DESC LIMIT 5").fetchall()
        outgoing=[i for i,item in enumerate(items) if item.startswith('out:')]
        for event,question,answer,snapshot in rows:
            fresh=new_messages(json.loads(snapshot),items)
            first_new=len(items)-len(fresh)
            for n,index in enumerate(outgoing):
                if index<first_new:continue
                start=outgoing[n-1]+1 if n else 0
                if text_key(items[index][4:])==text_key(answer) and text_key(incoming_question(items[start:index]))==text_key(question.removeprefix('in:')):
                    self.finish(event,'sent',answer);confirmed.append(event);break
        return confirmed

    def needs_confirmation(self):
        return bool(self.db.execute("SELECT 1 FROM events WHERE status IN ('uncertain','sending') AND id>(SELECT COALESCE(MAX(id),0) FROM events WHERE status='sent') LIMIT 1").fetchone())

    def pending(self):
        return list(self.db.execute("SELECT id,message,status FROM events WHERE status IN ('reserved','sending','uncertain') ORDER BY id"))

    def history(self, limit=8, after=0):
        rows = self.db.execute("SELECT message,answer FROM events WHERE status='sent' AND id>? ORDER BY id DESC LIMIT ?", (after,limit)).fetchall()
        out = []
        for message,answer in reversed(rows):
            out.extend([{'role':'user','content':message.removeprefix('in:')}, {'role':'assistant','content':answer}])
        return out

    def close(self):
        self.db.close()
