const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../comment-tools.js'),'utf8'),ctx);
const tools=ctx.ABEMACommentTools, now=Date.now()-1000;
const c=(id,message,offset=0,userId='a',extra={})=>({id,userId,message,createdAtMs:now+offset,...extra});
const smile='\u{1F600}';

test('emoji-only recognizes whole Unicode sequences without treating digits or text as emoji',()=>{
  for(const value of [smile,`${smile} \n${smile}`,'\u{1F44D}\u{1F3FD}','\u2764\uFE0F',
    '\u{1F1EF}\u{1F1F5}','1\uFE0F\u20E3','\u{1F469}\u200D\u{1F4BB}',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}']) {
    assert.equal(tools.isEmojiOnly(value),true,JSON.stringify(value));
  }
  for(const value of ['', ' ', '123', '#*', ':)', '(^^)', `${smile}!`, `${smile}です`,
    '\u{1F1EF}', '\u200D', '\uFE0F', '\u{1F3FD}', `${smile}\u200D`]) {
    assert.equal(tools.isEmojiOnly(value),false,JSON.stringify(value));
  }
});
test('emoji evidence counts unique reliable posts and rejects a mixed window',()=>{
  const cs=[c('a',smile,-100000),c('b',smile,-40000),c('c',smile)];
  assert.equal(tools.emojiEvidence(cs).count,3);
  assert.equal(tools.emojiEvidence([cs[0],cs[0],cs[1]]),null);
  assert.equal(tools.emojiEvidence([...cs,c('mixed','hello',-20000)]),null);
  assert.equal(tools.emojiEvidence(cs.map(c=>({...c,timestampReliable:false}))),null);
  assert.equal(tools.emojiEvidence(cs,{emojiWindowSec:30}),null);
  assert.equal(tools.emojiEvidence([cs[0]],{emojiCount:1}).count,1);
  assert.equal(tools.emojiEvidence([...cs].reverse()).count,3);
});
test('automatic labels annotate each comment with evidence and do not mutate source records',()=>{
  const cs=[c('a','ＡＢＣ?'),c('b','normal'),c('c',smile),c('d','https://example.test/')];
  const before=JSON.stringify(cs);
  const rows=tools.annotate(cs,{rules:[{label:'指定語',keywords:['abc']}]});
  assert.deepEqual(Array.from(rows[0].labels,x=>x.name),['疑問表現','指定語']);
  assert.equal(rows[1].labels.length,0);
  assert.equal(rows[2].labels[0].name,'絵文字のみ');
  assert.equal(rows[3].labels[0].name,'URLあり');
  assert.equal(JSON.stringify(cs),before);
  assert.ok(rows[0].labels.every(label=>label.reason));
  assert.ok(tools.annotate(cs,{enabled:false}).every(row=>row.labels.length===0));
});
test('repetition is per user and frequency uses real posting times, never batch arrival',()=>{
  const cs=Array.from({length:8},(_,i)=>c(String(i),'same',-i*10000));
  const rows=tools.annotate(cs,undefined,{rateCount:8,rateWindowSec:120});
  assert.ok(rows.every(row=>row.labels.some(label=>label.name==='同文反復')));
  assert.ok(rows.every(row=>row.labels.some(label=>label.name==='高頻度投稿')));
  const unreliable=tools.annotate(cs.map(c=>({...c,timestampReliable:false})));
  assert.ok(unreliable.every(row=>!row.labels.some(label=>label.name==='高頻度投稿')));
  const isolated=tools.annotate(cs.map((c,i)=>({...c,userId:String(i)})));
  assert.ok(isolated.every(row=>row.labels.length===0));
});
test('comment search returns only matching comments from a user and supports label, page, mute and ordering',()=>{
  const rows=tools.annotate([c('a','XX',-2000),c('b','unrelated',-1000),c('c','ｘｘ？',0,'b',{pageUrl:'channel'})]);
  assert.deepEqual(Array.from(tools.filterRows(rows,{query:'xx'}),x=>x.comment.id),['c','a']);
  assert.deepEqual(Array.from(tools.filterRows(rows,{query:'xx',order:'oldest'}),x=>x.comment.id),['a','c']);
  assert.equal(tools.filterRows(rows,{query:'xx',hideMuted:true,mutedUsers:['a']}).length,1);
  assert.equal(tools.filterRows(rows,{channel:'channel',label:'疑問表現'}).length,1);
  assert.equal(tools.filterRows(rows,{query:'a',target:'user'}).length,2);
});
test('rule validation rejects malformed backups and duplicate/reserved labels',()=>{
  assert.equal(tools.parseRules('災害: 地震, 津波')[0].keywords.length,2);
  for(const value of [null,[],{rules:[null]},{rules:[{label:'x',keywords:[42]}]},
    {rules:[{label:'URLあり',keywords:['x']}]},{enabled:'yes'},
    {rules:[{label:'x',keywords:['a']},{label:'x',keywords:['b']}]}]) {
    assert.throws(()=>tools.normalizeLabelSettings(value));
  }
  assert.throws(()=>tools.parseRules('invalid rule'));
});
test('replay uses timestamps for speed, seeking, next, tied timestamps and end state',()=>{
  const replay=new tools.Replay(), rows=tools.annotate([c('last','last',10000),c('start','start',0),c('tie','tie',0)]);
  replay.reset(rows);
  assert.equal(replay.visible().count,2);
  replay.playing=true;replay.speed=2;replay.advance(2000);
  assert.equal(replay.position,now+4000);assert.equal(replay.visible().count,2);
  replay.next();assert.equal(replay.visible().count,3);
  replay.advance(1000);assert.equal(replay.playing,false);
  replay.seek(now-1000);assert.equal(replay.position,now);
  rows.push({comment:c('new','new',20000),labels:[]});assert.equal(replay.rows.length,3);
  replay.reset([]);assert.equal(replay.visible().count,0);
});
