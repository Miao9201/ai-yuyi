import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {installationId, localOperationTimeout, readLogTail} from './local-helpers.mjs';

test('tail preserves UTF-8, CRLF, empty/trailing lines and long lines exactly', () => {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'yuyi-tail-')));
  try {
    const file=path.join(directory,'synthetic.log');
    for(const text of ['', '你好\n第二行', '甲\r\n乙\r\n', '甲\n\n乙\n', '甲'.repeat(40000)+'\n末尾😀', 'x'.repeat(65533)+'中文\r\n尾巴\n']) {
      fs.writeFileSync(file,text);
      for(const lines of [1,2,3,20]) assert.equal(readLogTail(file,lines),text.split(/\r?\n/).slice(-lines).join('\n'));
    }
    assert.equal(readLogTail(path.join(directory,'missing'),2),'');
    assert.equal(readLogTail(file,NaN),'');assert.equal(readLogTail(file,0),'');
  } finally {
    assert.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('two lines from a 16MB log read at most one 64KB block', () => {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'yuyi-tail-')));
  const original=fs.readSync;let bytes=0;
  try {
    const file=path.join(directory,'synthetic.log');fs.writeFileSync(file,'x'.repeat(16*1024*1024)+'\n最后一行前\n最后一行');
    fs.readSync=(...args)=>{const count=original(...args);bytes+=count;return count;};
    assert.equal(readLogTail(file,2),'最后一行前\n最后一行');assert.ok(bytes<=65536);
  } finally {
    fs.readSync=original;
    assert.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('model checks allow the full configured 5 minute request; other operation limits stay intact', () => {
  assert.ok(localOperationTimeout('api_settings.py','test')>300000);
  assert.ok(localOperationTimeout('api_settings.py','models')>300000);
  assert.equal(localOperationTimeout('api_settings.py','save'),65000);
  assert.equal(localOperationTimeout('import_persona.py','import'),600000);
  assert.equal(localOperationTimeout('memory_editor.py','list'),65000);
});

test('installation identity is canonical, path-free and distinct for separate copies', () => {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'yuyi-installation-')));
  try {
    const a=path.join(directory,'one'),b=path.join(directory,'two');fs.mkdirSync(a);fs.mkdirSync(b);
    const canonical=fs.realpathSync.native(a);const normalized=process.platform==='win32'?canonical.toLowerCase():canonical;
    assert.equal(installationId(a),createHash('sha256').update(normalized).digest('hex'));
    assert.notEqual(installationId(a),installationId(b));assert.match(installationId(a),/^[a-f0-9]{64}$/);
  } finally {
    assert.equal(path.dirname(directory),fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
