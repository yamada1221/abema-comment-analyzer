const $ = (id) => document.getElementById(id);
async function render(){
  const d=await chrome.storage.local.get(['comments','captureEnabled','lastCommentAt']);
  const now=Date.now(); const comments=(d.comments||[]).filter(c=>now-(c.observedAt||c.createdAtMs)<=24*3600000);
  $('count').textContent=comments.length; $('users').textContent=new Set(comments.map(c=>c.userId)).size;
  const enabled=d.captureEnabled!==false; $('toggle').textContent=enabled?'記録を停止':'記録を開始';
  $('status').innerHTML=d.lastCommentAt?`<span class="ok">● 受信あり</span> 最終 ${new Date(d.lastCommentAt).toLocaleTimeString()}`:'<span class="warn">● まだコメント未検出</span>';
}
$('open').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')});
$('toggle').onclick=async()=>{const d=await chrome.storage.local.get('captureEnabled');await chrome.storage.local.set({captureEnabled:d.captureEnabled===false});render();};
$('clear').onclick=async()=>{await chrome.storage.local.set({comments:[],lastCommentAt:null});render();};
render();
