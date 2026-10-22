/* 语忆AI memory editor. Loads only on explicit navigation, search or refresh. */
(() => {
  'use strict';
  const root = document.getElementById('tab-memory');
  if (!root) return;
  const el = id => root.querySelector('#' + id);
  const ui = {
    scopes: [], scope: null, query: '', origin: 'all', status: 'active',
    items: [], total: 0, offset: 0, limit: 20, selected: null, creating: false,
    baseline: '', loaded: false, loading: false, busy: false, request: 0, topicRequest: 0,
  };
  const labels = {manual: '手动补充'};
  const scopeKey = scope => scope ? JSON.stringify([scope.account || '', scope.persona]) : '';
  const scopeBody = () => ({account: ui.scope?.account || '', persona: ui.scope?.persona || ''});
  const ready = () => ui.scope?.ready === true;
  const draft = () => ({text: el('memoryText').value, pinned: el('memoryPinned').checked});
  const dirty = () => (ui.creating || !!ui.selected) && JSON.stringify(draft()) !== ui.baseline;

  function mayDiscard() {
    return !dirty() || window.confirm('当前记忆有未保存的修改。放弃这些修改并继续？');
  }
  function message(error) {
    const text = String(error?.message || '记忆操作失败，请稍后重试');
    if (error?.status === 409 || /409|已被更新|已改变|版本冲突/.test(text)) {
      toast('记录已更新，当前输入已保留。请复制需要的内容后刷新。', true);
    } else {
      toast(text, true);
    }
  }
  function dateText(value) {
    if (!value) return '日期未记录';
    const input = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? String(value).slice(0, 80) : date.toLocaleString('zh-CN', {hour12: false});
  }
  function node(tag, text, className = '') {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = String(text);
    if (className) result.className = className;
    return result;
  }
  function sourceText(row) {
    return labels[row.origin] || '';
  }

  function controls() {
    const waiting = ui.busy || ui.loading;
    const editable = ready() && (ui.creating || !!ui.selected) && !ui.selected?.deleted && !waiting;
    for (const id of ['memoryText', 'memoryPinned']) el(id).disabled = !editable;
    for (const id of ['memoryScope', 'memoryQuery', 'memoryStatus', 'memorySearch', 'memoryReload', 'memoryOrigin']) el(id).disabled = waiting;
    el('memoryNew').disabled = waiting || !ready();
    el('memorySave').disabled = !editable || !dirty();
    el('memoryDiscard').disabled = waiting || !dirty();
    el('memoryDelete').disabled = waiting || !ui.selected || !!ui.selected.deleted;
    el('memoryRestore').hidden = !ui.selected?.deleted;
    el('memoryRestore').disabled = waiting || !ui.selected?.deleted;
    el('memoryDelete').hidden = !!ui.selected?.deleted;
    el('memoryUndo').disabled = waiting || !ui.selected || ui.selected.undo_id == null;
    el('memoryPrevious').disabled = waiting || !ready() || ui.offset === 0;
    el('memoryNext').disabled = waiting || !ready() || ui.offset + ui.limit >= ui.total;
    el('memoryTopicsReload').disabled = waiting || !ready();
    el('memoryDraftState').textContent = ui.busy ? '正在保存…' : dirty() ? '有未保存的修改' : '';
    el('memoryLength').textContent = `${el('memoryText').value.length}/${el('memoryPinned').checked ? 800 : 8000} 字`;
    el('memoryLimitNote').textContent = el('memoryPinned').checked ? '最多固定 5 条，每条 800 字。' : '';
    el('memoryText').maxLength = el('memoryPinned').checked ? 800 : 8000;
  }

  function renderEditor() {
    const row = ui.selected;
    el('memoryText').value = row?.text || '';
    el('memoryPinned').checked = !!row?.pinned;
    el('memoryEntryMeta').textContent = ui.creating ? '新记忆'
      : row ? [sourceText(row), dateText(row.at), row.edited ? '已修改' : '',
          row.deleted ? '已删除' : row.pinned ? '已固定' : ''].filter(Boolean).join(' · ')
        : '选择或新增一条记忆';
    ui.baseline = JSON.stringify(draft());
    controls();
  }

  function renderList() {
    const list = el('memoryList');
    list.replaceChildren();
    if (!ui.items.length) list.append(node('p', ready() ? '没有符合当前筛选条件的记录。' : '连接这位用户后，再查看其独立记忆。', 'note'));
    for (const row of ui.items) {
      const item = node('div', undefined, 'item' + (ui.selected?.id === row.id ? ' active' : ''));
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-pressed', String(ui.selected?.id === row.id));
      const copy = node('div');
      copy.style.minWidth = '0';
      copy.style.width = '100%';
      const text = String(row.text || '');
      const turn = row.origin === 'live' ? /\r?\nAI[：:]/.exec(text) : null;
      if (turn) {
        const persona = ui.scope?.personaName || ui.scope?.persona || 'AI';
        copy.append(node('div', text.slice(0, turn.index).replace(/\s+/g, ' ').trim(), 'n memory-line memory-user'),
          node('div', `AI（${persona}）：${text.slice(turn.index + turn[0].length).replace(/\s+/g, ' ').trim()}`, 'n memory-line memory-assistant'));
      } else {
        copy.append(node('div', text.replace(/\s+/g, ' ').slice(0, 100) || '（空记录）', 'n memory-line'));
      }
      const status = [sourceText(row), row.pinned ? '固定' : '', row.deleted ? '已删除' : ''].filter(Boolean).join(' · ');
      if (status) copy.append(node('div', status, 's'));
      copy.append(node('div', dateText(row.at), 's memory-date'));
      item.append(copy);
      const select = () => {
        if (ui.busy || ui.loading || ui.selected?.id === row.id || !mayDiscard()) return;
        ui.selected = row;
        ui.creating = false;
        renderEditor();
        renderList();
      };
      item.addEventListener('click', select);
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); select();}
      });
      list.append(item);
    }
    el('memoryCount').textContent = `共 ${ui.total} 条${ui.query ? '匹配记录' : '记录'}`;
    el('memoryPage').textContent = `${Math.floor(ui.offset / ui.limit) + 1} / ${Math.max(1, Math.ceil(ui.total / ui.limit))}`;
    controls();
  }

  async function fetchRows({selectFirst = false} = {}) {
    const ticket = ++ui.request;
    if (!ready()) {
      ui.items = []; ui.total = 0; ui.offset = 0;
      renderList();
      return;
    }
    ui.loading = true;
    el('memoryCount').textContent = '正在读取记忆…';
    controls();
    const params = new URLSearchParams({...scopeBody(), query: ui.query, origin: ui.origin, status: ui.status, offset: String(ui.offset)});
    try {
      const data = await api('/api/memory?' + params);
      if (ticket !== ui.request) return;
      ui.items = Array.isArray(data.items) ? data.items : [];
      ui.total = Number(data.total) || 0;
      ui.limit = Number(data.limit) || 20;
      ui.offset = Number(data.offset) || 0;
      if (!ui.items.length && ui.offset > 0 && ui.total <= ui.offset) {
        ui.offset = Math.max(0, Math.floor((ui.total - 1) / ui.limit) * ui.limit);
        return await fetchRows({selectFirst});
      }
      if (selectFirst) {
        ui.selected = ui.items[0] || null;
        ui.creating = false;
        renderEditor();
      }
      renderList();
    } catch (error) {
      if (ticket === ui.request) {
        el('memoryCount').textContent = '读取失败，当前编辑内容已保留。';
        message(error);
      }
    } finally {
      if (ticket === ui.request) {ui.loading = false; controls();}
    }
  }

  function resetSelection() {
    ui.selected = null; ui.creating = false; ui.items = []; ui.total = 0; ui.offset = 0;
    renderEditor(); renderList();
  }
  function scopeNote() {
    el('memoryScopeNote').textContent = !ui.scope ? '暂无人设。' : !ready() ? '请先连接该用户的微信。' : '';
    el('memoryOrigin').value = ui.origin;
  }
  async function loadScopes() {
    const previous = scopeKey(ui.scope);
    const data = await api('/api/memory/scopes');
    ui.scopes = Array.isArray(data.scopes) ? data.scopes : [];
    ui.scope = ui.scopes.find(scope => scopeKey(scope) === previous) || ui.scopes.find(scope => scope.ready) || ui.scopes[0] || null;
    const selector = el('memoryScope');
    selector.replaceChildren();
    for (const scope of ui.scopes) {
      const option = node('option', scope.label + (scope.ready ? '' : '（尚未连接）'));
      option.value = scopeKey(scope);
      option.disabled = !scope.ready;
      selector.append(option);
    }
    selector.value = scopeKey(ui.scope);
    scopeNote();
  }

  async function loadTopics() {
    const ticket = ++ui.topicRequest;
    const body = el('memoryTopicsBody');
    if (!ready()) {body.textContent = '连接后可查看当前人设的话题状态。'; return;}
    body.textContent = '正在读取当前人设的话题状态…';
    try {
      const data = await api('/api/memory/topics?' + new URLSearchParams(scopeBody()));
      if (ticket !== ui.topicRequest) return;
      body.replaceChildren();
      for (const [title, rows, banned] of [['近期话题', data.history, false], ['暂不主动提起', data.bans, true]]) {
        body.append(node('h4', title));
        if (!Array.isArray(rows) || !rows.length) {body.append(node('p', '暂无记录。')); continue;}
        const list = node('ul');
        for (const row of rows) {
          const label = row.label || (Array.isArray(row.labels) ? row.labels.join('、') : '') || (Array.isArray(row.keywords) ? row.keywords.join('、') : '') || '未命名话题';
          const detail = banned ? `截至 ${dateText(row.until)}` : `最近 ${dateText(row.lastAt)} · 提及 ${Number(row.mentions) || 0} 次`;
          list.append(node('li', `${label} · ${detail}`));
        }
        body.append(list);
      }
    } catch (error) {
      if (ticket === ui.topicRequest) {body.textContent = '读取失败，请点击刷新话题状态重试。'; message(error);}
    }
  }

  function validateDraft() {
    const data = draft();
    if (!data.text.trim()) throw new Error('记忆内容不能为空。');
    if (data.text.length > (data.pinned ? 800 : 8000)) throw new Error(data.pinned ? '固定记忆最多 800 字。' : '普通记忆最多 8000 字。');
    return data;
  }

  async function mutate(action, extra, success) {
    if (ui.busy || ui.loading || !ready()) return;
    const current = ui.selected;
    ui.busy = true; controls();
    try {
      const payload = {...scopeBody(), ...(current ? {id: current.id, revision: current.revision} : {}), ...extra};
      const result = await post('/api/memory/' + action, payload);
      if (!result.entry) throw new Error('保存结果缺少记录，请刷新核实。');
      ui.selected = result.entry; ui.creating = false;
      renderEditor();
      toast(success);
      await fetchRows();
    } catch (error) {
      message(error);
    } finally {
      ui.busy = false; controls();
    }
  }

  el('memoryScope').addEventListener('change', async () => {
    const key = el('memoryScope').value;
    if (!mayDiscard()) {el('memoryScope').value = scopeKey(ui.scope); return;}
    ui.scope = ui.scopes.find(scope => scopeKey(scope) === key) || null;
    ++ui.topicRequest;
    scopeNote(); resetSelection();
    await fetchRows({selectFirst: true});
    if (el('memoryTopics').open) loadTopics();
    else el('memoryTopicsBody').textContent = '展开后读取当前人设的话题状态。';
  });
  async function applyFilters(event) {
    event?.preventDefault();
    if (!mayDiscard()) {el('memoryOrigin').value = ui.origin; el('memoryStatus').value = ui.status; return;}
    ui.query = el('memoryQuery').value;
    ui.origin = el('memoryOrigin').value;
    ui.status = el('memoryStatus').value;
    resetSelection();
    await fetchRows({selectFirst: true});
  }
  el('memorySearchForm').addEventListener('submit', applyFilters);
  el('memoryOrigin').addEventListener('change', applyFilters);
  el('memoryStatus').addEventListener('change', applyFilters);
  el('memoryReload').addEventListener('click', async () => {
    if (ui.loading || ui.busy || !mayDiscard()) return;
    ui.loading = true; controls();
    try {
      await loadScopes(); resetSelection();
      await fetchRows({selectFirst: true});
      if (el('memoryTopics').open) loadTopics();
    } catch (error) {message(error);}
    finally {ui.loading = false; controls();}
  });
  for (const [id, direction] of [['memoryPrevious', -1], ['memoryNext', 1]]) {
    el(id).addEventListener('click', async () => {
      if (!mayDiscard()) return;
      const next = Math.max(0, ui.offset + direction * ui.limit);
      ui.selected = null; ui.creating = false; ui.offset = next;
      renderEditor();
      await fetchRows({selectFirst: true});
    });
  }
  el('memoryNew').addEventListener('click', () => {
    if (!ready() || !mayDiscard()) return;
    ui.selected = null; ui.creating = true;
    renderEditor(); renderList();
    el('memoryText').focus();
  });
  el('memorySave').addEventListener('click', () => {
    try {
      const data = validateDraft();
      if (ui.creating) mutate('add', data, '已新增记忆');
      else if (ui.selected) mutate('change', {changes: data}, '记忆已保存');
    } catch (error) {message(error);}
  });
  el('memoryDiscard').addEventListener('click', () => {
    if (!mayDiscard()) return;
    renderEditor();
  });
  el('memoryDelete').addEventListener('click', () => {
    if (!ui.selected || !mayDiscard() || !window.confirm('删除这条记录？删除后停止使用，可在“已删除”中恢复。')) return;
    mutate('change', {changes: {deleted: true}}, '记录已删除，可恢复');
  });
  el('memoryRestore').addEventListener('click', () => {
    if (!ui.selected?.deleted || !mayDiscard()) return;
    mutate('change', {changes: {deleted: false}}, '记录已恢复');
  });
  el('memoryUndo').addEventListener('click', () => {
    if (!ui.selected || ui.selected.undo_id == null || !mayDiscard() || !window.confirm('撤销所选记录上一次操作？')) return;
    mutate('undo', {audit_id: ui.selected.undo_id}, '已撤销上次操作');
  });
  for (const id of ['memoryText', 'memoryPinned']) el(id).addEventListener('input', controls);
  el('memoryTopics').addEventListener('toggle', () => {if (el('memoryTopics').open) loadTopics();});
  el('memoryTopicsReload').addEventListener('click', loadTopics);
  window.addEventListener('beforeunload', event => {
    if (dirty()) {event.preventDefault(); event.returnValue = '';}
  });
  for (const button of document.querySelectorAll('nav [data-tab]')) button.addEventListener('click', event => {
    if (button.dataset.tab !== 'memory' && !mayDiscard()) {event.preventDefault(); event.stopImmediatePropagation();}
  }, true);

  window.loadMemory = async function loadMemory() {
    if (ui.loaded || ui.loading) return;
    ui.loading = true; controls();
    try {
      await loadScopes();
      resetSelection();
      await fetchRows({selectFirst: true});
      ui.loaded = true;
    } catch (error) {message(error);}
    finally {ui.loading = false; controls();}
  };
  renderEditor();
  renderList();
})();
