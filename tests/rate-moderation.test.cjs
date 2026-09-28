const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const now = Date.now()-1000;
const source = fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
function detector(options={}) {
  const ctx=vm.createContext({moderation:{enabled:true,rateEnabled:true,rateCount:8,rateWindowSec:120,duplicateEnabled:false,duplicateWindowSec:60,ngEnabled:false,...options},userActivity:new Map(),whitelistCache:new Set(),mutedUsersCache:new Set()});
  vm.runInContext(source.slice(source.indexOf('  function normalizeMessage'),source.indexOf('  async function autoMute')),ctx);
  return c=>ctx.moderationReason(c);
}
const comment=(id,offset,extra={})=>({id,userId:'test-user',message:'message '+id,createdAtMs:now+offset,timestampReliable:true,...extra});
test('one per minute never triggers 8/120s even in a batch or reverse order',()=>{
  const cs=Array.from({length:20},(_,i)=>comment(String(i),-i*60000));
  for(const input of [cs,[...cs].reverse()]){const run=detector();for(const c of input)assert.equal(run(c),null);}
});
test('unknown timestamps cannot turn history batch into a burst; NG still applies',()=>{
  const run=detector();
  for(let i=0;i<20;i++)assert.equal(run(comment(String(i),0,{timestampReliable:false})),null);
  for(const value of [undefined,0,NaN,Infinity,now/1000]) assert.equal(run(comment('bad',0,{createdAtMs:value})),null);
  assert.match(detector({ngEnabled:true,ngWords:['blocked']})(comment('ng',0,{message:'blocked',timestampReliable:false})),/NGワード/);
});
test('same ID does not increase frequency',()=>{
  const run=detector();for(let i=0;i<20;i++)assert.equal(run(comment('same',-i)),null);
});
test('8 distinct comments in 120 seconds trigger with posting-time evidence',()=>{
  const run=detector();let result;
  for(let i=0;i<8;i++)result=run(comment(String(i),-105000+i*15000));
  assert.equal(result.reason,'高頻度投稿 8件/120秒');assert.equal(result.evidence.spanSeconds,105);
});
test('out-of-order comments across a 2W interval do not count as W',()=>{
  const run=detector({rateCount:4,rateWindowSec:120});
  for(const [i,t]of [-240000,-180000,0,-120000].entries())assert.equal(run(comment(String(i),t)),null);
  // Exactly 120 seconds is accepted as the window boundary.
  const boundary=detector({rateCount:3,rateWindowSec:120});
  boundary(comment('a',-120000));boundary(comment('b',0));
  assert.equal(boundary(comment('c',-60000)).evidence.spanSeconds,120);
});
test('duplicate rule also ignores unreliable times and repeated notifications',()=>{
  const run=detector({rateEnabled:false,duplicateEnabled:true,duplicateCount:3});
  for(let i=0;i<5;i++)assert.equal(run(comment(String(i),0,{message:'same',timestampReliable:false})),null);
  assert.equal(run(comment('a',-40000,{message:'same'})),null);
  assert.equal(run(comment('a',-40000,{message:'same'})),null);
  assert.equal(run(comment('b',-20000,{message:'same'})),null);
  assert.match(run(comment('c',0,{message:'same'})).reason,/同文/);
});
test('bridge marks fallback timestamps as unreliable and preserves real posting time',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../page-bridge.js'),'utf8');
  const payloads=[];
  const ctx=vm.createContext({SOURCE:'test',seen:new Set(),oldestSeenAt:Infinity,window:{postMessage:d=>payloads.push(d.payload)}});
  vm.runInContext(src.slice(src.indexOf('  function commentKey'),src.indexOf('  function getText')),ctx);
  ctx.emitComment({id:'unknown',userId:'u',message:'old'});
  ctx.emitComment({id:'known',userId:'u',message:'new',createdAtMs:now});
  assert.equal(payloads[0].timestampReliable,false);
  assert.equal(payloads[1].timestampReliable,true);
  assert.equal(payloads[1].createdAtMs,now);
});
