(() => {
  'use strict';
  const tools = ABEMACommentTools, el = id => document.getElementById(id);
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  let rows = [], matches = [], muted = [], settings = tools.DEFAULT_TAG_SETTINGS, page = 0;
  let tagDirty = false, queryTimer, replayTimer, lastTick = 0, replayShown = -1;
  const replay = new tools.Replay(), pageSize = 100;
  function badges(items) {
    return items.map(item => `<span class="user-tag" title="${escape(item.reason)}">${escape(item.name)}</span>`).join('');
  }
  function highlighted(message) {
    const q = tools.normalize(el('commentQuery').value).trim(), text = String(message || '');
    if (!q || el('commentTarget').value === 'user') return escape(text);
    // Map normalized matches back to original code points, including full-width text.
    let normalized = '', offsets = [], offset = 0;
    for (const char of text) {
      const part = tools.normalize(char);
      normalized += part;
      for (let i = 0; i < part.length; i++) offsets.push([offset, offset+char.length]);
      offset += char.length;
    }
    let html = '', end = 0, from = 0, index;
    while ((index = normalized.indexOf(q, from)) >= 0) {
      const start = offsets[index][0], next = offsets[index+q.length-1][1];
      if (start >= end) { html += escape(text.slice(end,start)) + `<mark>${escape(text.slice(start,next))}</mark>`; end = next; }
      from = index+q.length;
    }
    return html+escape(text.slice(end));
  }
  function cards(list, prefix) {
    return list.map((row,i) => {
      const c = row.comment, uid = String(c.userId);
      return `<article class="comment-result"><div class="comment-heading"><time>${escape(date(tools.time(c)))}</time>
        <button type="button" data-result-user="${escape(uid)}">${escape(uid)}</button>
        <button type="button" class="mute" data-result-mute="${escape(uid)}">${muted.includes(uid)?'ミュート解除':'ミュート'}</button></div>
        <p class="msg" id="${prefix}-${i}">${highlighted(c.message)}</p>
        <div class="tag-badges">${badges(row.tags)}</div>
        <p class="comment-source">${escape(c.pageTitle || '番組情報なし')}${c.timestampReliable === false?' / 投稿時刻不明（取得時刻）':''}</p></article>`;
    }).join('');
  }
  function bindCards(container) {
    container.querySelectorAll('[data-result-user]').forEach(button => button.onclick = () => {
      selectUser(button.dataset.resultUser);
      el('detailTitle').scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    container.querySelectorAll('[data-result-mute]').forEach(button => button.onclick = async () => {
      button.disabled = true;
      try { await toggleMute(button.dataset.resultMute); }
      catch (error) { el('commentStatus').textContent = `ミュートの保存に失敗しました: ${error.message || error}`; }
      finally { button.disabled = false; }
    });
  }
  function options(select, choices) {
    const current = select.value;
    if (current && !choices.some(([value]) => value === current)) choices.push([current, current]);
    select.innerHTML = choices.map(([value,label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join('');
    select.value = current;
  }
  function render() {
    matches = tools.filterRows(rows, { query: el('commentQuery').value, target: el('commentTarget').value,
      tag: el('commentTagFilter').value, channel: el('commentChannel').value, hideMuted: el('hideMutedComments').checked,
      mutedUsers: muted, order: el('commentOrder').value });
    page = Math.min(page, Math.max(0,Math.ceil(matches.length/pageSize)-1));
    const start = page*pageSize, visible = matches.slice(start,start+pageSize), box = el('commentResults');
    el('commentStatus').textContent = `${matches.length}件一致 / 分析範囲内 ${rows.length}件${matches.length?` / ${start+1}〜${start+visible.length}件表示`:''}`;
    box.innerHTML = visible.length ? cards(visible,'search-comment') : '<p class="muted-text">一致するコメントはありません。検索条件または分析時間を変更してください。</p>';
    bindCards(box);
    el('commentPrev').disabled = page === 0;
    el('commentNext').disabled = start+pageSize >= matches.length;
    el('exportCommentResults').disabled = !matches.length;
    el('loadReplay').disabled = !matches.length;
  }
  function filterChanged() {
    page = 0;
    pause(); replay.reset([]); replayShown = -1; renderReplay();
    render();
  }
  el('commentQuery').oninput = () => { clearTimeout(queryTimer); queryTimer = setTimeout(filterChanged, 150); };
  for (const id of ['commentTarget','commentTagFilter','commentChannel','hideMutedComments','commentOrder']) el(id).onchange = filterChanged;
  el('clearCommentSearch').onclick = () => { el('commentQuery').value = ''; el('commentTarget').value='message'; el('commentTagFilter').value=''; el('commentChannel').value=''; el('hideMutedComments').checked=false; filterChanged(); };
  el('commentPrev').onclick = () => { page--; render(); };
  el('commentNext').onclick = () => { page++; render(); };
  el('exportCommentResults').onclick = () => download('abema-comment-search.json', JSON.stringify(matches.map(row => ({...row.comment, userTags:row.tags.map(item=>item.name)})),null,2),'application/json');
  el('autoTagsEnabled').onchange = el('autoTagRules').oninput = () => { tagDirty=true; el('autoTagStatus').textContent='未保存の変更があります。'; };
  el('saveAutoTags').onclick = async () => {
    const controls = ['saveAutoTags', 'autoTagsEnabled', 'autoTagRules'].map(el);
    if (el('saveAutoTags').disabled) return;
    controls.forEach(control => control.disabled = true);
    try {
      const next = { enabled: el('autoTagsEnabled').checked, rules: tools.parseRules(el('autoTagRules').value) };
      await navigator.locks.request('abema-comment-analyzer-user-tags', async () => {
        const data = await chrome.storage.local.get('storageSchemaVersion');
        if (Number(data.storageSchemaVersion) > 6) throw new Error('新しい保存形式です。拡張機能を更新してください。');
        await chrome.storage.local.set({ autoTagSettings: next });
      });
      await ABEMAAutoUserTags.refresh();
      tagDirty = false;
      await load(false);
      el('autoTagStatus').textContent = next.enabled ? '保存しました。保存履歴からユーザータグを追加しました。' : '自動付与を停止しました。保存済みのタグは保持します。';
    } catch (error) { el('autoTagStatus').textContent = error.message || String(error); }
    finally { controls.forEach(control => control.disabled = false); }
  };
  function refresh(comments, mutedUsers, config, userTags) {
    settings = tools.normalizeTagSettings(config);
    const muteChanged = JSON.stringify(muted) !== JSON.stringify(mutedUsers);
    rows = comments.map(comment => ({ comment, tags: ABEMAUserTags.get(userTags, String(comment.userId))
      .map(name => ({ name, reason: '投稿者のユーザータグ' })) }));
    muted = [...mutedUsers];
    options(el('commentTagFilter'), [['','すべてのタグ'], ...[...new Set(Object.values(userTags).flat())].sort().map(name=>[name,name])]);
    const channels = new Map();
    for (const row of rows) if(row.comment.pageUrl) channels.set(row.comment.pageUrl,row.comment.pageUrl.replace(/^https:\/\/abema.tv\//,''));
    options(el('commentChannel'), [['','すべてのページ'], ...channels.entries()]);
    if (!tagDirty) { el('autoTagsEnabled').checked=settings.enabled; el('autoTagRules').value=settings.rules.map(rule=>`${rule.tag}: ${rule.keywords.join(', ')}`).join('\n'); }
    render();
    // Keep the loaded replay fixed while capture and search results continue updating.
    if (muteChanged && replay.rows.length) { replayShown=-1; renderReplay(true); }
  }
  function pause() { replay.playing=false; clearInterval(replayTimer); replayTimer=null; }
  function renderReplay(keepScroll = false) {
    const visible=replay.visible();
    el('replayPlay').textContent=replay.playing?'一時停止':'再生';
    for (const id of ['replayPlay','replayRestart','replayNext','replaySeek']) el(id).disabled=!replay.rows.length;
    el('replaySeek').max=String(Math.max(1,replay.end-replay.start));
    el('replaySeek').value=String(replay.position-replay.start);
    el('replaySeek').setAttribute('aria-valuetext',replay.rows.length?date(replay.position):'未選択');
    el('replayStatus').textContent=replay.rows.length?`${date(replay.position)} / ${visible.count} / ${replay.rows.length}件${replay.position>=replay.end?' / 再生終了':''}（直近100件を表示）`:'検索結果を読み込むとリプレイできます。';
    if (replayShown !== visible.count) {
      const box=el('replayComments'), scroll=box.scrollTop;box.innerHTML=cards(visible.rows,'replay-comment');bindCards(box);
      box.scrollTop=keepScroll?scroll:box.scrollHeight; replayShown=visible.count;
    }
  }
  el('loadReplay').onclick = () => {
    clearTimeout(queryTimer); render(); pause();
    replay.reset(matches.map(row=>({comment:{...row.comment},tags:row.tags.map(tag=>({...tag}))})));
    replay.speed=Number(el('replaySpeed').value); replayShown=-1;renderReplay();
  };
  el('replayPlay').onclick = () => {
    if (replay.playing) pause();
    else if (replay.rows.length) {
      if (replay.position>=replay.end) replay.seek(replay.start);
      replay.playing=true;lastTick=performance.now();
      replayTimer=setInterval(()=>{
        const now=performance.now();replay.advance(now-lastTick);lastTick=now;
        if (!replay.playing) pause();renderReplay();
      },100);
    }
    renderReplay();
  };
  el('replayRestart').onclick = () => {pause();replay.seek(replay.start);renderReplay();};
  el('replayNext').onclick = () => {pause();replay.next();renderReplay();};
  el('replaySpeed').onchange = () => {replay.speed=Number(el('replaySpeed').value);lastTick=performance.now();};
  el('replaySeek').oninput = () => {pause();replay.seek(replay.start+Number(el('replaySeek').value));renderReplay();};
  document.addEventListener('visibilitychange',()=>{if(document.hidden){pause();renderReplay();}});
  window.addEventListener('pagehide',pause);
  globalThis.ABEMAExplorer={refresh};
  renderReplay();
})();
