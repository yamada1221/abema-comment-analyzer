const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../learning-model.js'),'utf8'),ctx);
const model = ctx.ABEMACommentLearning;
const now = Date.now()-1000;
const post = (id,userId,message,offset=0) => ({id,userId,message,createdAtMs:now+offset,observedAt:now,timestampReliable:true});
const source = post('source','source-user','ワレおっさんジエンすんな');
const selected = () => model.addSelectedSample(undefined,source,now);
const input = () => [source,post('a','candidate','ワレおっさんジエンすんな'),
  post('b','candidate','ワレおっさんジエンすんなよ'),post('c','candidate','普通の実況'),
  ...Array.from({length:3},(_,i)=>post('normal'+i,'normal','今日は涼しくて散歩が気持ちいい',i))];
const analyze = (data=input(),samples=selected(),extra={}) => model.analyze(data,[],[],{
  now,learningMinComments:3,learningSelectedSamples:samples,...extra});

test('one explicit comment enables focused learning without muting its author',()=>{
  const result=analyze();
  assert.equal(result.ready,true);assert.equal(result.mode,'selected-comments');
  assert.equal(result.trainingUsers,1);assert.equal(result.selectedSamples,1);
  const candidate=result.candidates.find(c=>c.userId==='candidate');
  assert.ok(candidate);assert.equal(candidate.matchedCommentCount,2);
  assert.equal(candidate.evidence[0].sourceUserId,'source-user');
  assert.equal(candidate.evidence[0].sourceMessage,source.message);
  assert.ok(candidate.evidence.every(e=>e.score>=model.SELECTED_MATCH_THRESHOLD));
  assert.ok(!result.candidates.some(c=>c.userId==='normal'||c.userId==='source-user'));
});
test('normal commentary among forty posts does not dilute two matching examples',()=>{
  const data=input().concat(Array.from({length:37},(_,i)=>post('extra'+i,'candidate','その他の通常実況'+i)));
  assert.ok(analyze(data).candidates.some(c=>c.userId==='candidate'));
});
test('unrelated selected examples are compared separately, not averaged',()=>{
  const samples=model.addSelectedSample(selected(),post('different','other-source','独自の政治的な長文を繰り返す投稿'),now);
  assert.ok(analyze(input(),samples).candidates.some(c=>c.userId==='candidate'));
});
test('one match and repeated notifications do not create a candidate',()=>{
  const data=[source,post('one','u',source.message),post('normal','u','その他の通常実況'),post('normal2','u','雨ですね')];
  assert.equal(analyze(data.concat(data[1],data[1])).candidates.length,0);
});
test('selected-comment similarity threshold is configurable',()=>{
  const lower=analyze(input(),selected(),{learningSelectedMatchThreshold:0.10});
  assert.ok(lower.candidates.some(c=>c.userId==='candidate'));
  const strict=analyze(input(),selected(),{learningSelectedMatchThreshold:1});
  assert.equal(strict.candidates.some(c=>c.userId==='candidate'),false);
});
test('the selected post itself is not counted as matching evidence',()=>{
  const data=[source,post('source2','source-user',source.message),post('source3','source-user','普通の実況')];
  assert.equal(analyze(data).candidates.length,0);
});
test('minimum candidate comments and whitelist remain effective',()=>{
  assert.equal(analyze(input(),selected(),{learningMinComments:5}).candidates.length,0);
  const result=model.analyze(input(),[],['candidate'],{now,learningMinComments:3,learningSelectedSamples:selected()});
  assert.equal(result.candidates.length,0);
  assert.equal(model.analyze(input(),['candidate'],[],{now,learningMinComments:3,learningSelectedSamples:selected()}).candidates.length,0);
});
test('explicit examples survive mute removal, history expiry, and old training gates',()=>{
  const data=input().filter(c=>c.id!=='source');
  assert.ok(analyze(data,selected(),{learningMinMutedUsers:200}).candidates.some(c=>c.userId==='candidate'));
  const unchanged=model.normalizeSelectedSamples(selected());
  assert.equal(unchanged.samples[0].message,source.message);
});
test('empty explicit samples retain the legacy model and training requirement',()=>{
  const result=analyze(input(),{version:1,samples:[]});
  assert.equal(result.ready,false);assert.equal(result.trainingUsers,0);
});
test('explicit examples deduplicate by comment identity without refreshing selection date',()=>{
  const first=selected(),again=model.addSelectedSample(first,source,now+10000);
  assert.equal(JSON.stringify(first),JSON.stringify(again));
  assert.equal(JSON.stringify(first),JSON.stringify(model.addSelectedSample(first,{...source,createdAtMs:now+10000},now+20000)));
  assert.equal(first.samples.length,1);
});
test('malformed and over-limit explicit examples are rejected, not truncated',()=>{
  for(const value of [null,{},[],{version:2,samples:[]},{version:1,samples:[null]}])assert.throws(()=>model.normalizeSelectedSamples(value));
  assert.throws(()=>model.addSelectedSample(undefined,post('bad','u','?!'),now));
  assert.throws(()=>model.addSelectedSample(undefined,post('bad','u','a'.repeat(4097)),now));
  let samples;
  for(let i=0;i<model.MAX_SELECTED_SAMPLES;i++)samples=model.addSelectedSample(samples,post('id'+i,'u','文'+i),now);
  assert.equal(samples.samples.length,200);
  assert.throws(()=>model.addSelectedSample(samples,post('overflow','u','超過'),now),/200/);
  assert.equal(model.addSelectedSample(samples,post('id0','u','文0'),now).samples.length,200);
});
test('HTML-looking text and unusual IDs remain literal sample data',()=>{
  const c=post('__proto__','__proto__','<img src=x onerror=alert(1)>');
  const sample=model.addSelectedSample(undefined,c,now).samples[0];
  assert.equal(sample.userId,'__proto__');assert.equal(sample.message,c.message);
  assert.equal({}.polluted,undefined);
});
