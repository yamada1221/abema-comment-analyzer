const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../learning-model.js'), 'utf8'), context);
const { updateMemory, analyze } = context.ABEMACommentLearning;
const now = Date.now(), day = 86400000;
const comments = (id, time, message = '特定の繰り返し発言') => Array.from({length:5}, (_,i) => ({userId:id, message, createdAtMs:time-i}));
test('next-day candidates use retained training samples; current candidates only', () => {
  const old = ['m1','m2','m3'].flatMap(id => comments(id,now-2*day));
  const memory = updateMemory(null,old,['m1','m2','m3'],[],now);
  const current = comments('candidate',now);
  assert.equal(analyze(current,['m1','m2','m3'],[],{now}).ready,false);
  const result = analyze(current,['m1','m2','m3'],[],{now,learningMemory:memory});
  assert.equal(result.ready,true);
  assert.equal(result.candidates[0].userId,'candidate');
  assert.equal(result.trainingUsers,3);
});
test('unmute, whitelist and auto-learning exclusions erase training samples', () => {
  const ids=['m1','m2','m3'];
  const memory=updateMemory(null,ids.flatMap(id=>comments(id,now)),ids,[],now);
  assert.equal(updateMemory(memory,[],['m2','m3'],['m2','m3'],now).samples.length,0);
  assert.equal(analyze([],ids,['m1'],{now,learningMemory:memory,learningTrainingExcludedUsers:['m2']}).trainingUsers,1);
});
test('repeated reads do not refresh sample dates; expired and malformed samples removed', () => {
  const data=comments('m',now-100*day);
  const first=updateMemory(null,data,['m'],[],now);
  const second=updateMemory(first,data,['m'],[],now+day);
  assert.equal(JSON.stringify(second),JSON.stringify(first));
  assert.equal(updateMemory(first,[],['m'],[],now+181*day).samples.length,0);
  assert.equal(updateMemory({samples:[null,{userId:'m',message:'a',createdAtMs:now+day}]},[],['m'],[],now).samples.length,0);
});
test('global and per-user bounds hold even for imported archives', () => {
  const ids=Array.from({length:210},(_,i)=>'id'+i);
  const data=ids.flatMap((id,j)=>Array.from({length:50},(_,i)=>({userId:id,message:'x'.repeat(1000)+i,createdAtMs:now-j*100-i})));
  const m=updateMemory(null,data,ids,[],now);
  assert.equal(m.samples.length,8000);
  assert.equal(new Set(m.samples.map(c=>c.userId)).size,200);
  assert.ok(m.samples.every(c=>c.message.length<=160));
});
test('background persists memory across history removal and prunes after unmute', async () => {
  const state={comments:comments('m',now),mutedUsers:['m'],moderationSettings:{learningEnabled:true}};
  const listeners=[];
  const ctx=vm.createContext({console,navigator:{locks:{request:async(_key,fn)=>fn()}},chrome:{storage:{local:{
    get:async keys=>Object.fromEntries(keys.filter(k=>k in state).map(k=>[k,structuredClone(state[k])])),
    set:async update=>{Object.assign(state,structuredClone(update));}
  },onChanged:{addListener:fn=>listeners.push(fn)}}}});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../learning-model.js'),'utf8'),ctx);
  const source=fs.readFileSync(require('node:path').join(__dirname,'../background.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('// A single writer')),ctx);
  await vm.runInContext('learningMemoryQueue',ctx);
  assert.equal(state.learningMemory.samples.length,5);
  state.comments=[];
  listeners[0]({comments:{}},'local');
  await vm.runInContext('learningMemoryQueue',ctx);
  assert.equal(state.learningMemory.samples.length,5);
  state.mutedUsers=[];
  listeners[0]({mutedUsers:{}},'local');
  await vm.runInContext('learningMemoryQueue',ctx);
  assert.equal(state.learningMemory.samples.length,0);
});
