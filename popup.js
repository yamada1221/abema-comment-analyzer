const $ = (id) => document.getElementById(id);
async function render(){
  const d=await chrome.storage.local.get(['comments','captureEnabled','lastCommentAt']);
  const now=Date.now(); const comments=(d.comments||[]).filter(c=>now-(c.observedAt||c.createdAtMs)<=30*24*3600000);
  $('count').textContent=comments.length; $('users').textContent=new Set(comments.map(c=>c.userId)).size;
  const enabled=d.captureEnabled!==false; $('toggle').textContent=enabled?'記録を停止':'記録を開始';
  $('status').innerHTML=d.lastCommentAt?`<span class="ok">● 受信あり</span> 最終 ${new Date(d.lastCommentAt).toLocaleTimeString()}`:'<span class="warn">● まだコメント未検出</span>';
}
$('open').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')});
$('toggle').onclick=async()=>{const d=await chrome.storage.local.get('captureEnabled');await chrome.storage.local.set({captureEnabled:d.captureEnabled===false});render();};
$('clear').onclick=async()=>{await chrome.storage.local.set({comments:[],lastCommentAt:null});render();};
render();
async function renderNetwork() {
  const { networkCaptureStatus: s } = await chrome.storage.local.get('networkCaptureStatus');
  if (!s) { $('network').textContent = '診断未受信。拡張機能とABEMAタブを再読み込みしてください。'; return; }
  $('network').textContent = [
    `対象: ${s.pageUrl}`,
    `計測開始: ${new Date(s.startedAt).toLocaleTimeString()}`,
    `接続作成: ${s.connections} / 接続成功: ${s.opened}`,
    `WS送信: ${s.sent ?? 0} / 購読らしき送信: ${s.subscriptionHints ?? 0}`,
    `関連fetch: 要求 ${s.fetchRequests ?? 0} / 応答 ${s.fetchResponses ?? 0}`,
    `関連XHR: 要求 ${s.xhrRequests ?? 0} / 応答 ${s.xhrResponses ?? 0}`,
    `受信: ${s.frames} / JSON受信: ${s.jsonFrames}`,
    `コメント解析: ${s.parsedComments}`,
    `切断: ${s.closed} / エラー: ${s.errors}`,
    `最終受信: ${s.lastFrameAt ? new Date(s.lastFrameAt).toLocaleTimeString() : '未受信'}`,
    `診断更新: ${new Date(s.updatedAt).toLocaleTimeString()}`,
    `データ項目: ${(s.sampleKeys || []).join(', ') || '未検出'}`,
    '直近に診断が届いたABEMAタブの情報です。'
    ,`診断版: ${s.diagnosticVersion || '旧版'}`,
    `API対象要求: ${s.apiSelected ?? 0} / 対象応答: ${s.apiResponses ?? 0}`,
    `画面移動で除外: ${s.apiRouteDiscarded ?? 0} / 本文なし: ${s.apiNoBody ?? 0}`,
    `API JSON解析: ${s.httpJson ?? 0} / APIコメント検出: ${s.httpComments ?? 0}`,
    `別経路のコメント候補: ${s.httpCandidates ?? 0}`,
    `API解析失敗: ${s.httpParseErrors ?? 0} / 対象外: ${s.httpSkipped ?? 0}`,
    `API最終解析: ${s.lastHttpAt ? new Date(s.lastHttpAt).toLocaleTimeString() : '未解析'}`,
    `全fetch: ${s.allFetch ?? 0} / 全XHR(open): ${s.allXhr ?? 0}`,
    `Worker: ${s.workers ?? 0} / SharedWorker: ${s.sharedWorkers ?? 0} / EventSource: ${s.eventSources ?? 0}`,
    '通信先（本文・認証情報は含みません）:',
    ...(s.destinations || []),
    '解析対象の選択結果:',
    ...(s.selectionReasons || []),
    'Worker内部・別フレームの通信は直接観測していません。'
  ].join('\n');
}
renderNetwork();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.networkCaptureStatus) renderNetwork();
});
