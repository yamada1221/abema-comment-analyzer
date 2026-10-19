let fixedHistoryAnchor = null;
let autoTagSettings, userLimit = 200, detailLimit = 500;
let learningMemory = null;
let learningSelectedSamples = { version: 1, samples: [] };
let learningSampleBusy = false;
const MAX_WINDOW_MINUTES=30*24*60; let storedComments=[],comments=[],mutedUsers=[],learningAutoMutedUsers=[],selected=null,windowMinutes=60,historyTargetTabId=null,learningResult=null,learningLastRun=0;
const DEFAULT_MODERATION={enabled:false,emojiEnabled:false,emojiCount:3,emojiWindowSec:120,rateEnabled:true,rateCount:8,rateWindowSec:30,duplicateEnabled:true,duplicateCount:3,duplicateWindowSec:60,ngEnabled:true,ngWords:[],whitelistUsers:[],learningEnabled:false,learningMinComments:5,learningMinMutedUsers:3,learningMaxCommentsPerUser:40,learningCandidateThreshold:0.25,learningSelectedMatchThreshold:0.70,learningAutoMute:false,learningAutoMuteThreshold:0.40,learningNormalPenalty:0.75};
const DEFAULT_AUTO_PROGRAM=ABEMAAutoPrograms.DEFAULTS;
const STORAGE_SCHEMA_VERSION=6;
const TRANSFER_FORMAT='abema-comment-analyzer-transfer';
const TRANSFER_KEYS=['comments','mutedUsers','learningAutoMutedUsers','analysisWindowMinutes','moderationSettings','autoMuteLog','captureEnabled','lastCommentAt','autoProgramSettings','userTags','learningMemory','learningSelectedSamples','autoTagSettings','autoTagExclusions'];
const $=id=>document.getElementById(id);
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function commentTime(c){return Number(c.createdAtMs||c.observedAt||0);}
function analysisAnchor(){return fixedHistoryAnchor ?? (storedComments.reduce((latest,c)=>Math.max(latest,commentTime(c)||0),0)||Date.now());}
function formatDuration(minutes){if(minutes>=1440&&minutes%1440===0)return`${minutes/1440}日`;if(minutes<60)return`${minutes}分`;if(minutes%60===0)return`${minutes/60}時間`;return`${Math.floor(minutes/60)}時間${minutes%60}分`;}
function currentWindowFromControls(){const value=Math.max(1,Number($('windowValue').value)||1);const unit=Number($('windowUnit').value)||1;return Math.min(MAX_WINDOW_MINUTES,Math.round(value*unit));}
function syncControlsFromMinutes(minutes){if(minutes>=1440&&minutes%1440===0){$('windowValue').value=minutes/1440;$('windowUnit').value='1440';}else if(minutes>=60&&minutes%60===0){$('windowValue').value=minutes/60;$('windowUnit').value='60';}else{$('windowValue').value=minutes;$('windowUnit').value='1';}}
function lines(v){return String(v||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);}
function renderAutoProgramSettings(settings) {
  const s={...DEFAULT_AUTO_PROGRAM,...(settings||{})};
  $('autoProgramEnabled').checked=!!s.enabled;
  $('autoProgramPrimaryEnabled').checked=!!s.primaryEnabled;
  $('autoProgramKeyword').value=s.keyword||'報道ステーション';
  $('autoProgramUrl').value=s.url||DEFAULT_AUTO_PROGRAM.url;
  $('autoProgramStart').value=s.startTime||'00:00';
  $('autoProgramEnd').value=s.endTime||'02:00';
  $('autoProgramCloseTab').checked=s.closeOwnedTab!==false;
  $('autoProgramOpenActive').checked=!!s.openActive;
  for (const [prefix, key] of [['News','news'], ['Cnn','cnn']]) {
    $(`autoProgram${prefix}Enabled`).checked=!!s[`${key}Enabled`];
    $(`autoProgram${prefix}Start`).value=s[`${key}StartTime`];
    $(`autoProgram${prefix}End`).value=s[`${key}EndTime`];
  }
  const days=new Set((s.days||[]).map(Number));
  document.querySelectorAll('.autoProgramDay').forEach(cb=>cb.checked=days.has(Number(cb.value)));
}
function renderAutoProgramStatus(status){const el=$('autoProgramStatus'),detail=$('autoProgramDetection');if(!status){el.textContent='未実行です。有効にして設定を保存するとバックグラウンド監視を開始します。';detail.textContent='';return;}const when=status.updatedAt?new Date(status.updatedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'';el.textContent=`${status.message||status.status||''}${when?' / '+when:''}`;const d=status.detection;if(!d){detail.textContent='';return;}if(d.timed){detail.textContent='指定時刻で記録中（番組名の一致は不要です）';return;}const samples=(d.samples||[]).slice(0,4).map(x=>x.text).filter(Boolean);detail.textContent=`番組名判定: ${d.matched?'一致':'不一致'} / score ${d.score??0}${d.pageTitle?' / '+d.pageTitle:''}${samples.length?' / 検出候補: '+samples.join(' ｜ '):''}`;}

function renderModerationSettings(settings){const s={...DEFAULT_MODERATION,...(settings||{})};$('modEnabled').checked=!!s.enabled;$('emojiEnabled').checked=!!s.emojiEnabled;$('emojiCount').value=s.emojiCount;$('emojiWindowSec').value=s.emojiWindowSec;$('rateEnabled').checked=!!s.rateEnabled;$('rateCount').value=s.rateCount;$('rateWindowSec').value=s.rateWindowSec;$('duplicateEnabled').checked=!!s.duplicateEnabled;$('duplicateCount').value=s.duplicateCount;$('duplicateWindowSec').value=s.duplicateWindowSec;$('ngEnabled').checked=!!s.ngEnabled;$('ngWords').value=(s.ngWords||[]).join('\n');$('whitelistUsers').value=(s.whitelistUsers||[]).join('\n');$('learningEnabled').checked=!!s.learningEnabled;$('learningMinComments').value=s.learningMinComments;$('learningMinMutedUsers').value=s.learningMinMutedUsers;$('learningCandidateThreshold').value=Math.round(Number(s.learningCandidateThreshold||0.25)*100);$('learningSelectedMatchThreshold').value=Math.round(Number(s.learningSelectedMatchThreshold||0.70)*100);$('learningAutoMute').checked=!!s.learningAutoMute;$('learningAutoMuteThreshold').value=Math.round(Number(s.learningAutoMuteThreshold||0.40)*100);}
let muteLogItems = [], revokeBusy = false;
const selectedMuteUsers = new Set();
function visibleMuteLog() {
  const reason = $('muteLogReason').value, date = $('muteLogDate').value;
  return muteLogItems.filter(x => (!reason || String(x.reason).startsWith(reason)) &&
    (!date || (Number.isFinite(Number(x.mutedAt)) && new Date(Number(x.mutedAt) + 9*3600000).toISOString().slice(0,10) === date)));
}
function renderAutoMuteLog(log) {
  muteLogItems = Array.isArray(log) ? [...log].reverse() : [];
  const items = visibleMuteLog();
  const eligible = new Set(items.filter(x=>!x.revokedAt).map(x=>String(x.userId)));
  for (const uid of selectedMuteUsers) if (!eligible.has(uid)) selectedMuteUsers.delete(uid);
  $('autoMuteLog').innerHTML = items.length ? items.map(x => {
    const uid=String(x.userId);
    return `<div class="mute-log-item"><div class="actions"><b>${escapeHtml(uid)}</b> — ${escapeHtml(x.reason)} ${x.revokedAt ? '<span>取り消し済み</span>' : `<label><input type="checkbox" data-mute-select="${escapeHtml(uid)}" ${selectedMuteUsers.has(uid)?'checked':''} ${revokeBusy?'disabled':''}>選択</label><button type="button" data-revoke-mute="${escapeHtml(uid)}" ${revokeBusy?'disabled':''}>このユーザーの判定を取り消す</button>`}</div><span class="muted-text">${escapeHtml(new Date(x.mutedAt||Date.now()).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}))} / ${escapeHtml(x.message||'')}</span></div>`;
  }).join('') : '条件に一致する自動ミュート履歴はありません。';
  document.querySelectorAll('[data-mute-select]').forEach(el=>el.onchange=()=>{
    if(el.checked)selectedMuteUsers.add(el.dataset.muteSelect);else selectedMuteUsers.delete(el.dataset.muteSelect);
    const uid=el.dataset.muteSelect;renderAutoMuteLog([...muteLogItems].reverse());
    [...document.querySelectorAll('[data-mute-select]')].find(input=>input.dataset.muteSelect===uid)?.focus({preventScroll:true});
  });
  document.querySelectorAll('[data-revoke-mute]').forEach(el=>el.onclick=()=>revokeAutoMutes([el.dataset.revokeMute]));
  $('revokeSelectedMutes').disabled = revokeBusy || !selectedMuteUsers.size;
  $('selectMuteLog').disabled = revokeBusy || !eligible.size;
}
async function revokeAutoMutes(ids) {
  if(revokeBusy || !ids.length)return;
  const targets=[...new Set(ids)];
  if(!confirm(`${targets.length}人の自動判定を取り消します。対象ユーザーのミュート（手動分を含む）を解除し、自動保存した学習元を削除して自動判定から除外します。続けますか？`))return;
  revokeBusy=true;renderAutoMuteLog([...muteLogItems].reverse());
  try {
    const result=await chrome.runtime.sendMessage({source:'abema-comment-analyzer',type:'REVOKE_AUTO_MUTE',userIds:targets});
    if(!result?.ok)throw new Error(result?.error||'拡張機能を再読み込みしてください。');
    selectedMuteUsers.clear();learningLastRun=0;
    $('revokeMuteStatus').textContent=`${result.count}人の判定を取り消し、自動判定から除外しました。再び自動判定する場合は除外リストから外してください。`;
    await load(true);
  } catch(error) { $('revokeMuteStatus').textContent=`取り消しに失敗しました: ${error.message||error}`; }
  finally {revokeBusy=false;renderAutoMuteLog([...muteLogItems].reverse());}
}
$('muteLogReason').onchange=$('muteLogDate').onchange=()=>renderAutoMuteLog([...muteLogItems].reverse());
$('selectMuteLog').onclick=()=>{visibleMuteLog().filter(x=>!x.revokedAt).forEach(x=>selectedMuteUsers.add(String(x.userId)));renderAutoMuteLog([...muteLogItems].reverse());};
$('revokeSelectedMutes').onclick=()=>revokeAutoMutes([...selectedMuteUsers]);

function setTransferStatus(message,isError=false){const el=$('transferStatus');el.textContent=message;el.style.color=isError?'#f99':'#aaa';}
function renderSelectedLearningSamples() {
  const samples = learningSelectedSamples.samples;
  $('learningSelectedCount').textContent = `${samples.length} / ${ABEMACommentLearning.MAX_SELECTED_SAMPLES}件`;
  $('learningSelectedList').innerHTML = samples.length ? `<ul>${samples.map((sample,i) => `<li>
    <div class="learning-sample-heading"><b>${escapeHtml(sample.userId)}</b>
      <button type="button" data-selected-remove="${i}" aria-describedby="selected-message-${i}" ${learningSampleBusy?'disabled':''}>学習指定を解除</button></div>
    <p id="selected-message-${i}" class="msg">${escapeHtml(sample.message)}</p>
    <span class="time">${escapeHtml(new Date(sample.createdAtMs).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}))}</span>
    </li>`).join('')}</ul>` : '<p class="muted-text">投稿者を選び、問題になったコメントの「このコメントを学習」を押してください。</p>';
  document.querySelectorAll('[data-selected-remove]').forEach(button => {
    const sample = samples[Number(button.dataset.selectedRemove)];
    button.onclick = () => changeSelectedLearningComment(sample.key, true);
  });
}

async function changeSelectedLearningComment(commentKey, remove = false) {
  if (learningSampleBusy) return;
  learningSampleBusy = true;
  const active = document.activeElement;
  const focusKey = active?.dataset.learningkey;
  const focusUser = selected;
  const wasList = active?.hasAttribute('data-selected-remove');
  document.querySelectorAll('[data-learncomment],[data-selected-remove]').forEach(b => b.disabled = true);
  try {
    const result = await chrome.runtime.sendMessage({source:'abema-comment-analyzer',
      type:remove?'REMOVE_LEARNING_COMMENT':'SELECT_LEARNING_COMMENT',commentKey});
    if (!result?.ok) throw new Error(result?.error || '拡張機能を再読み込みしてください。');
    learningLastRun = 0;
    await load(false);
    $('learningSampleStatus').textContent = remove ? '学習指定を解除しました。' : 'このコメントを学習元に指定しました。';
    $('learningSampleStatus').classList.remove('error-text');
  } catch (error) {
    $('learningSampleStatus').textContent = `学習指定の保存に失敗しました: ${error.message || error}`;
    $('learningSampleStatus').classList.add('error-text');
  } finally {
    learningSampleBusy = false;
    renderSelectedLearningSamples();
    if (selected) renderDetail(selected);
    if (focusKey !== undefined && selected === focusUser) [...document.querySelectorAll('[data-learncomment]')].find(b=>b.dataset.learningkey===focusKey)?.focus({preventScroll:true});
    else if (wasList) (document.querySelector('[data-selected-remove]') || $('learningSelectedDetails').querySelector('summary')).focus({preventScroll:true});
  }
}

function renderLearningCandidates(settings,force=false) {
  const box=$('learningCandidates'),status=$('learningStatus'),cfg={...DEFAULT_MODERATION,...(settings||{})};
  if(!cfg.learningEnabled){learningResult=null;box.innerHTML='';status.textContent='学習型ミュートは無効です。指定したコメントは保存されています。';return;}
  if(!globalThis.ABEMACommentLearning){box.innerHTML='';status.textContent='学習モデルを読み込めませんでした。';return;}
  const now=Date.now();
  if(force||!learningResult||now-learningLastRun>=10000){
    learningResult=ABEMACommentLearning.analyze(storedComments,mutedUsers,cfg.whitelistUsers||[],
      {...cfg,learningMemory,learningSelectedSamples,learningTrainingExcludedUsers:learningAutoMutedUsers});
    learningLastRun=now;
  }
  if(!learningResult.ready){box.innerHTML='';status.textContent=learningResult.reason||'学習データが不足しています。';return;}
  const auto=cfg.learningAutoMute?` / 自動ミュート ${Math.round(Number(cfg.learningAutoMuteThreshold||0.40)*100)}%以上`:' / 候補表示のみ';
  const source=learningResult.mode==='selected-comments'?`指定したコメント ${learningResult.selectedSamples}件`:`学習元 ${learningResult.trainingUsers}人`;
  status.textContent=`${source} / 比較対象 ${learningResult.normalUsers||0}人 / 候補 ${learningResult.candidates.length}人${auto}`;
  box.innerHTML=learningResult.candidates.length?learningResult.candidates.slice(0,50).map(x=>`<div class="learning-candidate">
    <b>${escapeHtml(x.userId)}</b> — 類似度 <b>${(x.score*100).toFixed(1)}%</b> / ${x.commentCount}件
    <button type="button" data-learnmute="${escapeHtml(x.userId)}">ミュート</button>
    <button type="button" data-learnwhite="${escapeHtml(x.userId)}">除外</button><br>
    <span class="muted-text">特徴: ${escapeHtml((x.patterns||[]).join(' / ')||'-')}</span>
    ${x.evidence?`<details class="learning-evidence"><summary>一致した投稿 ${x.matchedCommentCount}件（最大3件表示）</summary><ul>${x.evidence.map(e=>`<li>
      <p class="msg">${escapeHtml(e.message)}</p><span class="time">${escapeHtml(new Date(e.createdAtMs).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}))}</span>
      <p class="muted-text">学習元 ${escapeHtml(e.sourceUserId)} / 類似度 ${(e.score*100).toFixed(1)}%<br>${escapeHtml(e.sourceMessage)}</p>
      </li>`).join('')}</ul></details>`:''}
    </div>`).join(''):'候補はありません。';
  document.querySelectorAll('[data-learnmute]').forEach(b=>b.onclick=async()=>{const uid=b.dataset.learnmute;if(!mutedUsers.includes(uid))await toggleMute(uid);learningLastRun=0;});
  document.querySelectorAll('[data-learnwhite]').forEach(b=>b.onclick=async()=>{const uid=b.dataset.learnwhite;const d=await chrome.storage.local.get('moderationSettings');const next={...DEFAULT_MODERATION,...(d.moderationSettings||{})};next.whitelistUsers=[...new Set([...(next.whitelistUsers||[]).map(String),uid])];learningLastRun=0;await chrome.storage.local.set({moderationSettings:next});});
}
async function ensureStorageSchema(){const manifest=chrome.runtime.getManifest();const d=await chrome.storage.local.get(['storageSchemaVersion','installedExtensionVersion']);const current=Number(d.storageSchemaVersion)||0;if(current>STORAGE_SCHEMA_VERSION){setTransferStatus(`このデータは新しい保存形式 v${current} です。拡張機能を最新版へ更新してください。`,true);return;}if(current<STORAGE_SCHEMA_VERSION){await chrome.storage.local.set({storageSchemaVersion:STORAGE_SCHEMA_VERSION,lastSchemaMigrationAt:Date.now(),lastSchemaMigrationFrom:current});}if(d.installedExtensionVersion!==manifest.version){await chrome.storage.local.set({installedExtensionVersion:manifest.version,lastVersionUpgradeAt:Date.now(),previousExtensionVersion:d.installedExtensionVersion||null});}$('versionInfo').textContent=`v${manifest.version} / 保存形式 ${STORAGE_SCHEMA_VERSION}`;}
async function exportTransfer(){try{const all=await chrome.storage.local.get(TRANSFER_KEYS);const data={};for(const key of TRANSFER_KEYS)if(Object.prototype.hasOwnProperty.call(all,key))data[key]=all[key];data.userTags=ABEMAUserTags.normalizeMap(data.userTags);data.autoTagExclusions=ABEMAAutoUserTags.normalizeExclusions(data.autoTagExclusions);data.learningSelectedSamples=ABEMACommentLearning.normalizeSelectedSamples(data.learningSelectedSamples);const manifest=chrome.runtime.getManifest();const payload={format:TRANSFER_FORMAT,schemaVersion:STORAGE_SCHEMA_VERSION,extensionVersion:manifest.version,exportedAt:new Date().toISOString(),data};const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/T/,'-').replace(/\..+$/,'');download(`abema-comment-analyzer-transfer-v${manifest.version}-${stamp}.json`,JSON.stringify(payload,null,2),'application/json');setTransferStatus(`引継ぎファイルを書き出しました。コメント ${Array.isArray(data.comments)?data.comments.length:0}件、ミュート ${(data.mutedUsers||[]).length}件、タグ付きユーザー ${Object.keys(data.userTags).length}件を含みます。`);}catch(e){setTransferStatus(`書き出しに失敗しました: ${e.message||e}`,true);}}
function validateTransferData(data) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const id = value => (typeof value === 'string' && !!value.trim()) ||
    (typeof value === 'number' && Number.isFinite(value));
  const strings = value => Array.isArray(value) && value.every(x => typeof x === 'string');
  const ids = value => Array.isArray(value) && value.every(id);
  const time = value => Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
  const check = (valid, field) => {
    if (!valid) throw new Error(`引継ぎデータの ${field} の形式が正しくありません`);
  };
  const optional = (value, key, valid, prefix) => {
    if (Object.hasOwn(value, key)) check(valid(value[key]), `${prefix}.${key}`);
  };
  const comment = value => object(value) && id(value.userId) && typeof value.message === 'string' &&
    ['createdAtMs', 'observedAt'].every(key => !Object.hasOwn(value, key) || time(value[key])) &&
    ['pageUrl', 'pageTitle'].every(key => !Object.hasOwn(value, key) || typeof value[key] === 'string') &&
    ['id', 'commentId'].every(key => !Object.hasOwn(value, key) ||
      typeof value[key] === 'string' || (typeof value[key] === 'number' && Number.isFinite(value[key]))) &&
    ['timestampReliable', 'isOwner'].every(key => !Object.hasOwn(value, key) || typeof value[key] === 'boolean');
  check(object(data), 'data');
  if (Object.hasOwn(data, 'autoTagSettings')) ABEMACommentTools.normalizeTagSettings(data.autoTagSettings);
  if (Object.hasOwn(data, 'autoLabelSettings')) ABEMACommentTools.migrateLabelSettings(data.autoLabelSettings);
  if (Object.hasOwn(data, 'autoTagExclusions')) ABEMAAutoUserTags.normalizeExclusions(data.autoTagExclusions);
  // Match the actual 100,000-comment retention cap when restoring backups.
  // Validate before any storage write, rather than silently truncating a backup.
  optional(data, 'comments', value => Array.isArray(value) &&
    value.length <= 100000 && value.every(comment), 'data');
  for (const key of ['mutedUsers', 'learningAutoMutedUsers']) optional(data, key, ids, 'data');
  optional(data, 'captureEnabled', value => typeof value === 'boolean', 'data');
  optional(data, 'analysisWindowMinutes', value =>
    Number.isFinite(value) && value >= 1 && value <= MAX_WINDOW_MINUTES, 'data');
  optional(data, 'lastCommentAt', value => value === null || time(value), 'data');
  optional(data, 'autoMuteLog', value => Array.isArray(value) && value.every(entry =>
    object(entry) && id(entry.userId) && typeof entry.reason === 'string' &&
    ['mutedAt', 'revokedAt'].every(key => !Object.hasOwn(entry, key) || time(entry[key]))), 'data');
  if (Object.hasOwn(data, 'moderationSettings')) {
    const settings = data.moderationSettings;
    check(object(settings), 'moderationSettings');
    // Settings imported from a file bypass the dashboard's input clamps.
    // Reject negative, unbounded and out-of-range values before any write.
    const countKeys = new Set(['emojiCount', 'rateCount', 'duplicateCount',
      'learningMinComments', 'learningMinMutedUsers', 'learningMaxCommentsPerUser']);
    const secondsKeys = new Set(['emojiWindowSec', 'rateWindowSec', 'duplicateWindowSec']);
    const thresholdKeys = new Set(['learningCandidateThreshold', 'learningSelectedMatchThreshold',
      'learningAutoMuteThreshold', 'learningNormalPenalty']);
    for (const [key, fallback] of Object.entries(DEFAULT_MODERATION)) {
      let validator;
      if (Array.isArray(fallback)) validator = strings;
      else if (typeof fallback === 'number') {
        validator = value => Number.isFinite(value) && (
          countKeys.has(key) ? value >= (key === 'rateCount' || key === 'duplicateCount' ||
            key === 'learningMinComments' ? 2 : 1) && value <= 100000 :
          secondsKeys.has(key) ? value >= 1 && value <= 86400 :
          thresholdKeys.has(key) ? value >= 0 && value <= 1 :
          value >= 0 && value <= 100000
        );
      } else validator = value => typeof value === typeof fallback;
      optional(settings, key, validator, 'moderationSettings');
    }
  }
  if (Object.hasOwn(data, 'autoProgramSettings')) {
    const settings = data.autoProgramSettings;
    check(object(settings), 'autoProgramSettings');
    for (const [key, fallback] of Object.entries(DEFAULT_AUTO_PROGRAM)) {
      if (key !== 'days') optional(settings, key,
        typeof fallback === 'number' ? value => Number.isInteger(value) &&
          value >= 1 && value <= 1000 :
          value => typeof value === typeof fallback, 'autoProgramSettings');
    }
    optional(settings, 'days', value => Array.isArray(value) &&
      value.every(day => Number.isInteger(day) && day >= 0 && day <= 6), 'autoProgramSettings');
    optional(settings, 'url', value => {
      try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'abema.tv'; }
      catch (_) { return false; }
    }, 'autoProgramSettings');
    for (const key of ['startTime', 'endTime', 'newsStartTime', 'newsEndTime', 'cnnStartTime', 'cnnEndTime']) {
      optional(settings, key, value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value), 'autoProgramSettings');
    }
  }
  // The learning-memory writer retains at most 200 users x 40 comments.
  // Import must enforce the same bound to avoid an oversized model payload.
  optional(data, 'learningMemory', value => value === null ||
    (object(value) && value.version === 1 && Array.isArray(value.samples) &&
      value.samples.length <= 8000 && value.samples.every(comment)), 'data');
}

async function importTransferFile(file) {
  try {
    if (!file) return;
    // A malformed or gigantic backup must not exhaust Chrome memory by default.
    const maxBytes = 256 * 1024 * 1024;
    if (Number.isFinite(file.size) && file.size > maxBytes) {
      throw new Error('256MBを超える引継ぎファイルは読み込めません');
    }
    const jsonText = await file.text();
    if (typeof jsonText !== 'string' || jsonText.length > maxBytes) {
      throw new Error('引継ぎファイルが大きすぎるか読み込めません');
    }
    const payload = JSON.parse(jsonText);
    if (!payload || payload.format !== TRANSFER_FORMAT) {
      throw new Error('ABEMA Comment Analyzerの引継ぎファイルではありません');
    }
    const schema = payload.schemaVersion ?? 0;
    if (!Number.isInteger(schema) || schema < 0) throw new Error('保存形式の番号が正しくありません');
    if (schema > STORAGE_SCHEMA_VERSION) {
      throw new Error(`引継ぎデータの保存形式 v${schema} はこの拡張では新しすぎます。先に最新版へ更新してください`);
    }
    // Validate every imported field before the first storage write.
    validateTransferData(payload.data);
    const recording = payload.data.captureEnabled === true;
    const schedule = payload.data.autoProgramSettings?.enabled === true;
    const effects = [
      '現在保存しているコメント・タグ・ミュート・設定の一部が上書きされます。',
      recording ? '復元後、コメント記録がONになります。' : '',
      schedule ? '復元後、指定番組の自動起動・記録設定がONになります。' : '',
      '引継ぎデータを復元しますか？'
    ].filter(Boolean).join('\n');
    if (!window.confirm(effects)) {
      setTransferStatus('引継ぎをキャンセルしました。既存データは変更していません。');
      return;
    }
    const restore = {};
    for (const key of TRANSFER_KEYS) {
      if (Object.hasOwn(payload.data, key)) restore[key] = payload.data[key];
    }
    if (!Object.hasOwn(restore, 'autoTagSettings') && Object.hasOwn(payload.data, 'autoLabelSettings')) {
      restore.autoTagSettings = ABEMACommentTools.migrateLabelSettings(payload.data.autoLabelSettings);
    }
    restore.storageSchemaVersion = STORAGE_SCHEMA_VERSION;
    restore.lastTransferImportAt = Date.now();
    restore.lastTransferSourceVersion = String(payload.extensionVersion || 'unknown');
    if (Object.hasOwn(restore, 'userTags')) restore.userTags = ABEMAUserTags.normalizeMap(restore.userTags);
    if (Object.hasOwn(restore, 'learningSelectedSamples')) {
      restore.learningSelectedSamples = ABEMACommentLearning.normalizeSelectedSamples(restore.learningSelectedSamples);
    }
    await withUserTagsLock(() => navigator.locks.request('abema-learning-memory', async () => {
      if (Object.hasOwn(restore, 'learningMemory')) {
        const existing = await chrome.storage.local.get(['mutedUsers', 'learningAutoMutedUsers', 'moderationSettings']);
        restore.learningMemory = ABEMACommentLearning.updateMemory(restore.learningMemory, [],
          restore.mutedUsers || existing.mutedUsers,
          [...(restore.learningAutoMutedUsers || existing.learningAutoMutedUsers || []),
            ...((restore.moderationSettings || existing.moderationSettings || {}).whitelistUsers || [])]);
      }
      await navigator.locks.request('abema-comment-history', async () => {
        // Re-read under the write lock: another page may have upgraded storage
        // while the file was being read or the confirmation was open.
        const current = await chrome.storage.local.get('storageSchemaVersion');
        if (Number(current.storageSchemaVersion) > STORAGE_SCHEMA_VERSION) {
          throw new Error('新しい保存形式のデータは上書きできません。拡張機能を最新版へ更新してください。');
        }
        await chrome.storage.local.set(restore);
      });
    }));
    setTransferStatus(`引継ぎ完了: v${payload.extensionVersion || '?'} のデータを復元しました。コメント ${restore.comments?.length || 0}件、ミュート ${restore.mutedUsers?.length || 0}件。${Object.hasOwn(restore, 'userTags') ? 'タグも復元しました。' : '旧形式のため現在のタグは保持しました。'}`);
    await ABEMAAutoUserTags.refresh();
    await load();
  } catch (e) {
    setTransferStatus(`引継ぎに失敗しました: ${e.message || e}`, true);
  } finally {
    $('transferFile').value = '';
  }
}
async function load(renderForms=true){const d=await chrome.storage.local.get(['comments','mutedUsers','learningAutoMutedUsers','analysisWindowMinutes','historyLoadProgress','commentPanelOpenStatus','moderationSettings','autoMuteLog','autoProgramSettings','autoProgramStatus','userTags','learningMemory','learningSelectedSamples','autoTagSettings','backgroundCaptureStatus']);autoTagSettings=d.autoTagSettings;renderBackgroundCapture(d.backgroundCaptureStatus);learningMemory=d.learningMemory;learningSelectedSamples=ABEMACommentLearning.normalizeSelectedSamples(d.learningSelectedSamples);userTags=ABEMAUserTags.normalizeMap(d.userTags);storedComments=Array.isArray(d.comments)?d.comments:[];mutedUsers=(d.mutedUsers||[]).map(String);learningAutoMutedUsers=(d.learningAutoMutedUsers||[]).map(String);windowMinutes=Math.min(MAX_WINDOW_MINUTES,Math.max(1,Number(d.analysisWindowMinutes)||60));syncControlsFromMinutes(windowMinutes);renderHistoryStatus(d.historyLoadProgress);renderCommentPanelOpenStatus(d.commentPanelOpenStatus);if(renderForms){renderModerationSettings(d.moderationSettings);renderAutoProgramSettings(d.autoProgramSettings);}renderAutoProgramStatus(d.autoProgramStatus);renderAutoMuteLog(d.autoMuteLog);renderSelectedLearningSamples();renderLearningCandidates(d.moderationSettings);applyFilter();}
function applyFilter(){const anchor=analysisAnchor(),span=windowMinutes*60000;comments=storedComments.filter(c=>{const t=commentTime(c);return t&&anchor-t>=0&&anchor-t<=span;});render();}
function groups(){const m=new Map();for(const c of comments){const u=String(c.userId||'unknown');if(!m.has(u))m.set(u,[]);m.get(u).push(c);}return[...m].map(([userId,list])=>({userId,list,count:list.length})).sort((a,b)=>b.count-a.count);}
function avgGap(list){if(list.length<2)return'-';const t=list.map(commentTime).sort((a,b)=>a-b);let s=0;for(let i=1;i<t.length;i++)s+=t[i]-t[i-1];const sec=s/(t.length-1)/1000;return sec<60?`${sec.toFixed(1)}秒`:`${(sec/60).toFixed(1)}分`;}
function render(){ABEMAExplorer.refresh(comments,mutedUsers,autoTagSettings,userTags);const gs=groups();$('total').textContent=comments.length;$('unique').textContent=gs.length;$('muted').textContent=mutedUsers.length;const top=gs.slice(0,10).reduce((s,g)=>s+g.count,0);$('topShare').textContent=comments.length?`${(top/comments.length*100).toFixed(1)}%`:'0%';$('timelineTitle').textContent=`${fixedHistoryAnchor===null?'最新コメント基準':new Date(fixedHistoryAnchor).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+'基準'}・直近${formatDuration(windowMinutes)}のコメント数推移`;renderAvailableSpan();renderTimeline();renderTagFilter();renderUsers(gs);if(selected)renderDetail(selected);}
function renderAvailableSpan(){if(!storedComments.length){$('availableSpan').textContent='保存データなし';return;}const times=storedComments.map(commentTime).filter(Boolean);if(!times.length){$('availableSpan').textContent='保存データなし';return;}const oldest=times.reduce((a,b)=>Math.min(a,b),Infinity),newest=times.reduce((a,b)=>Math.max(a,b),0);const mins=Math.max(1,Math.round((newest-oldest)/60000));$('availableSpan').textContent=`保存中: ${formatDuration(mins)} / ${storedComments.length}件 / ${new Date(oldest).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} ～ ${new Date(newest).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}`;}
function renderUsers(gs){const q=$('userSearch').value.toLowerCase();const visible=tagFilteredGroups(gs).filter(g=>!q||g.userId.toLowerCase().includes(q)||ABEMAUserTags.get(userTags,g.userId).some(tag=>tag.toLowerCase().includes(q))||g.list.some(c=>String(c.message||'').toLowerCase().includes(q)));$('userListStatus').textContent=`${visible.length}ユーザー中 ${Math.min(userLimit,visible.length)}人表示 / 件数・割合は分析時間内のコメントが対象です。`;$('moreUsers').hidden=visible.length<=userLimit;$('usersBody').innerHTML=visible.slice(0,userLimit).map(g=>`<tr data-user="${escapeHtml(g.userId)}"><td>${escapeHtml(g.userId)}${tagBadges(g.userId)}</td><td>${g.count}</td><td>${comments.length?(g.count/comments.length*100).toFixed(1):0}%</td><td>${avgGap(g.list)}</td><td><button class="mute" data-mute="${escapeHtml(g.userId)}">${mutedUsers.includes(g.userId)?'解除':'ミュート'}</button></td></tr>`).join('');document.querySelectorAll('tr[data-user]').forEach(tr=>tr.onclick=e=>{if(e.target.dataset.mute)return;selectUser(tr.dataset.user);});document.querySelectorAll('[data-mute]').forEach(b=>b.onclick=async e=>{e.stopPropagation();await toggleMute(b.dataset.mute);});}
async function toggleMute(uid) {
  const state = await navigator.locks.request('abema-learning-memory', async () => {
    const d = await chrome.storage.local.get(['mutedUsers','learningAutoMutedUsers']);
    const set = new Set((d.mutedUsers || []).map(String)), learned = new Set((d.learningAutoMutedUsers || []).map(String));
    if (set.has(uid)) set.delete(uid); else set.add(uid);
    learned.delete(uid);
    const next = { mutedUsers: [...set], learningAutoMutedUsers: [...learned], learningRebuildRequest: Date.now() };
    await chrome.storage.local.set(next);
    return next;
  });
  mutedUsers = state.mutedUsers; learningAutoMutedUsers = state.learningAutoMutedUsers; learningLastRun = 0; render();
}
function renderDetail(uid) {
  syncTagEditor(uid);
  const all=comments.filter(c=>String(c.userId)===uid).sort((a,b)=>commentTime(a)-commentTime(b));
  const list=all.slice(-detailLimit);
  $('moreDetailComments').hidden=all.length<=detailLimit;
  const selectedKeys=new Set(learningSelectedSamples.samples.map(c=>c.key));
  const container=$('detailComments'),scroll=container.scrollTop;
  $('detailTitle').textContent=uid;
  $('detailMeta').innerHTML=`${all.length}件（最新${list.length}件を表示） / 平均間隔 ${avgGap(all)} <button class="mute" id="detailMute">${mutedUsers.includes(uid)?'ミュート解除':'この投稿者をミュート'}</button>`;
  container.innerHTML=list.length?list.map((c,i)=>{
    const chosen=selectedKeys.has(ABEMACommentLearning.selectedCommentKey(c));
    return `<div class="comment"><span class="time">${escapeHtml(new Date(commentTime(c)).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}))}</span>
      <span id="comment-message-${i}" class="msg">${escapeHtml(c.message)}</span>
      <div class="comment-learning"><button type="button" class="learning-comment-button ${chosen?'chosen':''}" data-learncomment="${i}"
        aria-describedby="comment-message-${i}" ${learningSampleBusy?'disabled':''}>${chosen?'学習指定を解除':'このコメントを学習'}</button>
      ${chosen?'<span class="learning-selected-badge">学習指定済み</span>':''}</div></div>`;
  }).join(''):'<p class="muted-text">分析時間内のコメントはありません。タグは継続して保存されています。</p>';
  container.scrollTop=scroll;
  container.querySelectorAll('[data-learncomment]').forEach(button=>{
    const c=list[Number(button.dataset.learncomment)],key=ABEMACommentLearning.selectedCommentKey(c);
    button.dataset.learningkey=key;
    button.onclick=()=>changeSelectedLearningComment(key,selectedKeys.has(key));
  });
  $('detailMute').onclick=()=>toggleMute(uid);
}
function renderTimeline(){const cv=$('timeline'),ctx=cv.getContext('2d');const w=cv.width,h=cv.height;ctx.clearRect(0,0,w,h);const binCount=12,bins=Array(binCount).fill(0),anchor=analysisAnchor(),span=windowMinutes*60000,binMs=span/binCount;for(const c of comments){const age=anchor-commentTime(c);const idx=binCount-1-Math.floor(age/binMs);if(idx>=0&&idx<binCount)bins[idx]++;}const max=Math.max(1,...bins);ctx.fillStyle='#ccc';ctx.font='12px system-ui';for(let i=0;i<binCount;i++){const x=40+i*((w-60)/(binCount-1)),barH=(bins[i]/max)*(h-55);ctx.fillRect(x-12,h-28-barH,24,barH);ctx.fillText(String(bins[i]),x-7,h-34-barH);ctx.fillStyle='#777';const remaining=Math.round(windowMinutes-(i*(windowMinutes/(binCount-1))));const label=remaining>=60?`${(remaining/60).toFixed(remaining%60?1:0)}h`:`${remaining}m`;ctx.fillText(label,x-14,h-8);ctx.fillStyle='#ccc';}}
function renderHistoryStatus(p){const el=$('historyStatus');if(!p){el.textContent='過去コメントを取得する場合は、ABEMAでコメント欄を表示した状態で「過去コメントを読み込む」を押してください。';$('cancelHistory').style.display='none';return;}const running=p.status==='running'||p.status==='starting';$('cancelHistory').style.display=running?'inline-block':'none';const oldest=p.oldestAt?` / 最古 ${new Date(p.oldestAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}`:'';el.textContent=`${p.message||p.status}${oldest}`;}
function renderCommentPanelOpenStatus(p){const el=$('commentPanelOpenStatus'),btn=$('openCommentPanelTest');if(!p){el.textContent='未テスト';btn.disabled=false;return;}const recent=Date.now()-Number(p.updatedAt||0)<15000;const busy=recent&&(p.status==='starting'||p.status==='clicking');btn.disabled=busy;const prefix=p.status==='success'?'成功: ':p.status==='error'?'失敗: ':'';el.textContent=prefix+(p.message||p.status||'');}
function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
async function findAbemaTab(){const tabs=await chrome.tabs.query({url:'https://abema.tv/*'});if(!tabs.length)return null;return tabs.find(t=>t.active)||tabs[0];}
$('saveAutoProgram').onclick=async()=>{
  const days=[...document.querySelectorAll('.autoProgramDay:checked')].map(cb=>Number(cb.value));
  let url=$('autoProgramUrl').value.trim();
  try{const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='abema.tv')throw new Error();url=u.href;}
  catch(_){$('autoProgramSaved').textContent='ABEMAのURLを指定してください';return;}
  if($('autoProgramPrimaryEnabled').checked&&!days.length){$('autoProgramSaved').textContent='監視曜日を1つ以上選んでください';return;}
  const settings={enabled:$('autoProgramEnabled').checked,primaryEnabled:$('autoProgramPrimaryEnabled').checked,
    keyword:$('autoProgramKeyword').value.trim()||'報道ステーション',url,days,
    startTime:$('autoProgramStart').value||'00:00',endTime:$('autoProgramEnd').value||'02:00',
    closeOwnedTab:$('autoProgramCloseTab').checked,openActive:$('autoProgramOpenActive').checked,missingPollsToStop:2};
  for(const [prefix,key] of [['News','news'],['Cnn','cnn']]){
    settings[`${key}Enabled`]=$(`autoProgram${prefix}Enabled`).checked;
    settings[`${key}StartTime`]=$(`autoProgram${prefix}Start`).value;
    settings[`${key}EndTime`]=$(`autoProgram${prefix}End`).value;
    if(!settings[`${key}StartTime`]||!settings[`${key}EndTime`]){
      $('autoProgramSaved').textContent='開始・終了時刻を入力してください';return;
    }
  }
  try{
    await chrome.storage.local.set({autoProgramSettings:settings});
    const result=await chrome.runtime.sendMessage({source:'abema-comment-analyzer',type:'AUTO_PROGRAM_SETTINGS_SAVED'});
    if(!result?.ok)throw new Error(result?.error||'バックグラウンド処理に接続できません');
    $('autoProgramSaved').textContent='保存しました';setTimeout(()=>$('autoProgramSaved').textContent='',1800);
  }catch(error){$('autoProgramSaved').textContent='監視の再設定に失敗しました。拡張機能を再読み込みしてください。';}
};
$('inspectAutoProgram').onclick=async()=>{const keyword=$('autoProgramKeyword').value.trim()||'報道ステーション';$('autoProgramStatus').textContent='現在のABEMA画面を確認しています…';try{const r=await chrome.runtime.sendMessage({source:'abema-comment-analyzer',type:'AUTO_PROGRAM_CHECK_NOW',keyword});if(!r?.ok)$('autoProgramStatus').textContent='番組名確認に失敗しました。';}catch(e){$('autoProgramStatus').textContent='バックグラウンド処理へ接続できません。拡張機能を再読み込みしてください。';}};
$('stopAutoProgram').onclick=async()=>{try{await chrome.runtime.sendMessage({source:'abema-comment-analyzer',type:'AUTO_PROGRAM_STOP_NOW'});}catch(e){$('autoProgramStatus').textContent='停止処理に失敗しました。';}};

$('openCommentPanelTest').onclick=async()=>{const id=Date.now();const tab=await findAbemaTab();if(!tab?.id){const p={status:'error',requestId:id,message:'ABEMAタブが見つかりません。ABEMAの視聴画面を開いてください。',updatedAt:id};await chrome.storage.local.set({commentPanelOpenStatus:p});renderCommentPanelOpenStatus(p);return;}const p={status:'starting',requestId:id,message:`ABEMAタブを検出しました: ${tab.title||'ABEMA'}`,updatedAt:id};await chrome.storage.local.set({commentPanelOpenStatus:p});renderCommentPanelOpenStatus(p);try{await chrome.tabs.sendMessage(tab.id,{source:'abema-comment-analyzer',type:'OPEN_COMMENT_PANEL_REQUEST',requestId:id});}catch(e){const err={status:'error',requestId:id,message:'ABEMAタブへ接続できません。拡張機能を更新後、ABEMAタブを再読み込みしてから再試行してください。',updatedAt:Date.now()};await chrome.storage.local.set({commentPanelOpenStatus:err});renderCommentPanelOpenStatus(err);}};
$('exportTransfer').onclick=exportTransfer;$('importTransfer').onclick=()=>$('transferFile').click();$('transferFile').onchange=e=>importTransferFile(e.target.files?.[0]);
$('saveModeration').onclick=async()=>{const settings={enabled:$('modEnabled').checked,emojiEnabled:$('emojiEnabled').checked,emojiCount:Math.min(100,Math.max(1,Math.round(Number($('emojiCount').value)||3))),emojiWindowSec:Math.min(86400,Math.max(1,Math.round(Number($('emojiWindowSec').value)||120))),rateEnabled:$('rateEnabled').checked,rateCount:Math.min(100000,Math.max(2,Number($('rateCount').value)||8)),rateWindowSec:Math.min(86400,Math.max(1,Number($('rateWindowSec').value)||30)),duplicateEnabled:$('duplicateEnabled').checked,duplicateCount:Math.min(100000,Math.max(2,Number($('duplicateCount').value)||3)),duplicateWindowSec:Math.min(86400,Math.max(1,Number($('duplicateWindowSec').value)||60)),ngEnabled:$('ngEnabled').checked,ngWords:lines($('ngWords').value),whitelistUsers:lines($('whitelistUsers').value),learningEnabled:$('learningEnabled').checked,learningMinComments:Math.min(100000,Math.max(2,Number($('learningMinComments').value)||5)),learningMinMutedUsers:Math.min(100000,Math.max(1,Number($('learningMinMutedUsers').value)||3)),learningMaxCommentsPerUser:40,learningCandidateThreshold:Math.max(0.01,Math.min(0.99,(Number($('learningCandidateThreshold').value)||25)/100)),learningSelectedMatchThreshold:Math.max(0.10,Math.min(1,(Number($('learningSelectedMatchThreshold').value)||70)/100)),learningAutoMute:$('learningAutoMute').checked,learningAutoMuteThreshold:Math.max(0.01,Math.min(1,(Number($('learningAutoMuteThreshold').value)||40)/100)),learningNormalPenalty:0.75};learningLastRun=0;await chrome.storage.local.set({moderationSettings:settings,learningRebuildRequest:Date.now()});renderModerationSettings(settings);$('moderationSaved').textContent='保存しました';renderLearningCandidates(settings,true);setTimeout(()=>$('moderationSaved').textContent='',1800);};
$('applyWindow').onclick=async()=>{const raw=$('historyAnchor').value;const anchor=raw?Date.parse(raw+'+09:00'):null;if(raw&&!Number.isFinite(anchor)){$('historyRangeStatus').textContent='基準日時を確認してください。';return;}fixedHistoryAnchor=anchor;$('historyRangeStatus').textContent='';windowMinutes=currentWindowFromControls();await chrome.storage.local.set({analysisWindowMinutes:windowMinutes});syncControlsFromMinutes(windowMinutes);applyFilter();};
$('showAllHistory').onclick=async()=>{fixedHistoryAnchor=null;$('historyAnchor').value='';windowMinutes=MAX_WINDOW_MINUTES;await chrome.storage.local.set({analysisWindowMinutes:windowMinutes});syncControlsFromMinutes(windowMinutes);$('historyRangeStatus').textContent='保存済みの最新コメントから30日間を表示します。';applyFilter();};
$('loadHistory').onclick=async()=>{const id=Date.now();const tab=await findAbemaTab();if(!tab?.id){const p={status:'error',requestId:id,message:'ABEMAタブが見つかりません。ABEMAを開いてコメント欄を表示してください。',updatedAt:id};await chrome.storage.local.set({historyLoadProgress:p});renderHistoryStatus(p);return;}historyTargetTabId=tab.id;const p={status:'starting',requestId:id,message:`ABEMAタブを検出しました。取得開始: ${tab.title||'ABEMA'}`,updatedAt:id};await chrome.storage.local.set({historyLoadProgress:p});renderHistoryStatus(p);try{await chrome.tabs.sendMessage(tab.id,{source:'abema-comment-analyzer',type:'LOAD_HISTORY_REQUEST',requestId:id});}catch(e){const err={status:'error',requestId:id,message:'ABEMAタブへ接続できません。ABEMAタブを再読み込みしてから再試行してください。',updatedAt:Date.now()};await chrome.storage.local.set({historyLoadProgress:err});renderHistoryStatus(err);}};
$('cancelHistory').onclick=async()=>{if(!historyTargetTabId){const tab=await findAbemaTab();historyTargetTabId=tab?.id||null;}if(historyTargetTabId)try{await chrome.tabs.sendMessage(historyTargetTabId,{source:'abema-comment-analyzer',type:'CANCEL_HISTORY_REQUEST',requestId:Date.now()});}catch(_){};};
$('refresh').onclick=()=>load();$('userSearch').oninput=()=>{userLimit=200;renderUsers(groups());};$('exportJson').onclick=()=>download('abema-comments.json',JSON.stringify(comments.map(c=>({...c,userTags:[...ABEMAUserTags.get(userTags,String(c.userId))]})),null,2),'application/json');$('exportCsv').onclick=()=>{
  const values=comments.map(c=>[
    new Date(commentTime(c)).toISOString(),c.userId,c.message,c.pageTitle,
    JSON.stringify(ABEMAUserTags.get(userTags,String(c.userId)))
  ]);
  download('abema-comments.csv',ABEMACsvExport.document(values),'text/csv;charset=utf-8');
};chrome.storage.onChanged.addListener((c,a)=>{if(a!=='local')return;if(c.learningMemory||c.learningSelectedSamples)learningLastRun=0;if(c.comments||c.mutedUsers||c.learningAutoMutedUsers||c.autoMuteLog||c.userTags||c.learningMemory||c.learningSelectedSamples||c.autoTagSettings)load(false);if(c.moderationSettings)load(true);if(c.backgroundCaptureStatus)renderBackgroundCapture(c.backgroundCaptureStatus.newValue);if(c.autoProgramSettings)renderAutoProgramSettings(c.autoProgramSettings.newValue);if(c.autoProgramStatus)renderAutoProgramStatus(c.autoProgramStatus.newValue);if(c.historyLoadProgress)renderHistoryStatus(c.historyLoadProgress.newValue);if(c.commentPanelOpenStatus)renderCommentPanelOpenStatus(c.commentPanelOpenStatus.newValue);});

let userTags = {};
let tagEditorUser = null;
let tagEditorOriginal = [];
let tagEditorDirty = false;
let tagSaveBusy = false;

function tagBadges(uid) {
  return `<div class="tag-badges">${ABEMAUserTags.get(userTags, uid).map(tag => `<span class="user-tag">${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function renderTagFilter() {
  const select = $('tagFilter');
  const previous = select.value;
  const names = [...new Set(Object.values(userTags).flat())].sort((a,b) => a.localeCompare(b, 'ja'));
  // Keep an active filter even when its last user has just been untagged.
  if (previous.startsWith('tag:') && !names.includes(previous.slice(4))) names.push(previous.slice(4));
  const choices = [['', '全ユーザー'], ['tagged', 'タグ付きユーザー'], ['untagged', 'タグなしユーザー'], ...names.map(name => [`tag:${name}`, name])];
  select.innerHTML = choices.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
  select.value = previous;
}

function tagFilteredGroups(gs) {
  const filter = $('tagFilter').value;
  const all = new Map(gs.map(g => [g.userId, g]));
  if (filter === 'tagged' || filter.startsWith('tag:')) {
    for (const uid of Object.keys(userTags)) {
      if (!all.has(uid)) all.set(uid, { userId: uid, list: [], count: 0 });
    }
  }
  return [...all.values()].filter(g => {
    const tags = ABEMAUserTags.get(userTags, g.userId);
    return !filter || (filter === 'tagged' && tags.length > 0) ||
      (filter === 'untagged' && tags.length === 0) ||
      (filter.startsWith('tag:') && tags.includes(filter.slice(4)));
  }).sort((a,b) => b.count - a.count || a.userId.localeCompare(b.userId));
}

function selectUser(uid) {
  if (tagSaveBusy) return;
  if (selected !== uid && tagEditorDirty && !confirm('未保存のタグ変更を破棄して別のユーザーを開きますか？')) return;
  if (selected !== uid) detailLimit = 500;
  selected = uid;
  renderDetail(uid);
}

function syncTagEditor(uid, force = false) {
  $('tagEditor').hidden = false;
  if (!force && tagEditorUser === uid && tagEditorDirty) return;
  const changedUser = tagEditorUser !== uid;
  tagEditorUser = uid;
  tagEditorOriginal = [...ABEMAUserTags.get(userTags, uid)];
  $('userTagsInput').value = tagEditorOriginal.join(', ');
  tagEditorDirty = false;
  if (changedUser || force) setTagStatus('');
}

function setTagStatus(message, error = false) {
  $('tagStatus').textContent = message;
  $('tagStatus').classList.toggle('error-text', error);
}

function withUserTagsLock(task) {
  // Chrome extension pages share an origin; serialize edits across open dashboards.
  return navigator.locks.request('abema-comment-analyzer-user-tags', task);
}

async function saveUserTags() {
  if (!selected || tagSaveBusy) return;
  const uid = selected;
  try {
    const tags = ABEMAUserTags.parse($('userTagsInput').value);
    const expected = [...tagEditorOriginal];
    tagSaveBusy = true;
    $('saveUserTags').disabled = true;
    $('userTagsInput').disabled = true;
    const next = await withUserTagsLock(async () => {
      const data = await chrome.storage.local.get(['userTags', 'autoTagExclusions', 'storageSchemaVersion']);
      if (Number(data.storageSchemaVersion) > STORAGE_SCHEMA_VERSION) throw new Error('新しい保存形式です。拡張機能を更新してください。');
      const current = ABEMAUserTags.normalizeMap(data.userTags);
      if (JSON.stringify(ABEMAUserTags.get(current, uid)) !== JSON.stringify(expected)) {
        throw new Error('自動付与・別の画面・引継ぎによってタグが更新されました。「保存済みに戻す」で確認してから編集してください。');
      }
      if (tags.length) Object.defineProperty(current, uid, { value: tags, enumerable: true, configurable: true, writable: true });
      else delete current[uid];
      const autoTagExclusions = ABEMAAutoUserTags.editedExclusions(data.autoTagExclusions, uid, expected, tags);
      await chrome.storage.local.set({ userTags: current, autoTagExclusions });
      return current;
    });
    userTags = next;
    syncTagEditor(uid, true);
    renderTagFilter();
    renderUsers(groups());
    setTagStatus(tags.length ? 'タグを保存しました。' : 'このユーザーのタグをすべて削除しました。');
  } catch (error) {
    setTagStatus(error.message || String(error), true);
  } finally {
    tagSaveBusy = false;
    $('saveUserTags').disabled = false;
    $('userTagsInput').disabled = false;
  }
}

$('userTagsInput').oninput = () => { tagEditorDirty = true; setTagStatus('未保存の変更があります。'); };
$('saveUserTags').onclick = saveUserTags;
$('resetUserTags').onclick = async () => {
  if (tagSaveBusy || !selected) return;
  try {
    const data = await chrome.storage.local.get('userTags');
    userTags = ABEMAUserTags.normalizeMap(data.userTags);
    syncTagEditor(selected, true);
  } catch (error) { setTagStatus(error.message || String(error), true); }
};
$('clearUserTags').onclick = () => {
  if (tagSaveBusy) return;
  $('userTagsInput').value = '';
  tagEditorDirty = true;
  setTagStatus('「タグを保存」で削除を確定します。');
};
document.querySelectorAll('[data-tag-preset]').forEach(button => {
  button.onclick = () => {
    if (tagSaveBusy) return;
    try {
      const tags = ABEMAUserTags.parse($('userTagsInput').value);
      $('userTagsInput').value = ABEMAUserTags.parse([...tags, button.dataset.tagPreset]).join(', ');
      tagEditorDirty = true;
      setTagStatus('未保存の変更があります。');
    } catch (error) { setTagStatus(error.message || String(error), true); }
  };
});
$('tagFilter').onchange = () => {userLimit=200;renderUsers(groups());};
$('moreUsers').onclick=()=>{userLimit+=200;renderUsers(groups());};
$('moreDetailComments').onclick=()=>{detailLimit+=500;renderDetail(selected);};
$('openTagUser').onsubmit = event => {
  event.preventDefault();
  try {
    const uid = ABEMAUserTags.userId($('tagUserId').value);
    $('tagLookupStatus').textContent = '';
    selectUser(uid);
    if (selected === uid) $('tagEditor').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) { $('tagLookupStatus').textContent = error.message || String(error); }
};

function renderBackgroundCapture(status){if(!status){$('backgroundCaptureStatus').textContent='バックグラウンド接続の確認待ちです。';return;}const when=new Date(status.updatedAt).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo'});$('backgroundCaptureStatus').textContent=status.enabled?`バックグラウンド: 接続 ${status.connected}/${status.tabs}タブ / 自動休止を抑制 ${status.protectedTabs}タブ / 保存待ち ${status.pending}件 / 確認 ${when}${status.discarded?' / 休止済みタブは再読み込みが必要です。':''}${status.connected<status.tabs?' / 未接続のABEMAタブを再読み込みしてください。':''}`:'コメント記録は停止中です。';}

(async()=>{await ensureStorageSchema();await ABEMAAutoUserTags.start();await load();})().catch(error=>setTransferStatus(`読み込みに失敗しました: ${error.message||error}`,true));
