const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
async function runtime(auto=false) {
  const now=Date.now()-1000;
  const c=(id,userId,message)=>({id,userId,message,createdAtMs:now,timestampReliable:true});
  const source=c('source','source-user','独自の定型煽りを繰り返す投稿');
  const state={comments:[source,c('a','target',source.message),c('b','target',source.message),c('c','target','普通の実況')],
    mutedUsers:[],moderationSettings:{learningEnabled:true,learningMinComments:3,learningAutoMute:auto},userTags:{'source-user':['識別用']}};
  const listeners=[],sent=[],timers=[];
  const ctx=vm.createContext({console,navigator:{locks:{request:async(_key,fn)=>fn()}},
    document:{title:'test'},location:{href:'https://abema.tv/now-on-air/abema-news'},window:{postMessage(){},addEventListener(){}},
    setTimeout:(fn,delay)=>{timers.push(delay);return timers.length;},clearTimeout(){},setInterval:()=>1,clearInterval(){},
    chrome:{runtime:{id:'test',onMessage:{addListener(){}},sendMessage:async command=>{sent.push(structuredClone(command));return ctx.ABEMAModerationStore.apply(command);}},
      storage:{local:{get:async keys=>structuredClone(Object.fromEntries(keys.filter(k=>k in state).map(k=>[k,state[k]]))),
        set:async update=>{const changes={};for(const[k,v]of Object.entries(update)){changes[k]={oldValue:state[k],newValue:structuredClone(v)};state[k]=structuredClone(v);}listeners.forEach(fn=>fn(changes,'local'));}},
        onChanged:{addListener:fn=>listeners.push(fn)}}}});
  vm.runInContext(read('learning-model.js'),ctx);vm.runInContext(read('moderation-store.js'),ctx);
  vm.runInContext(read('content.js').replace(/\}\)\(\);\s*$/,'globalThis.audit={runLearningAnalysis,loadRuntimeSettings};})();'),ctx);
  await ctx.audit.loadRuntimeSettings();
  await ctx.ABEMAModerationStore.apply({type:'SELECT_LEARNING_COMMENT',commentKey:ctx.ABEMACommentLearning.selectedCommentKey(source)});
  return {ctx,state,sent,timers,source};
}
test('selected examples reach content analysis and candidate-only mode preserves user settings',async()=>{
  const r=await runtime(false),settings=JSON.stringify(r.state.moderationSettings),tags=JSON.stringify(r.state.userTags);
  await r.ctx.audit.runLearningAnalysis();
  assert.equal(r.state.learningStatus.ready,true);assert.equal(r.state.learningStatus.mode,'selected-comments');
  assert.equal(r.state.learningStatus.selectedSamples,1);assert.equal(r.state.learningStatus.candidateCount,1);
  assert.equal(r.state.mutedUsers.length,0);assert.equal(r.sent.length,0);
  assert.equal(JSON.stringify(r.state.moderationSettings),settings);assert.equal(JSON.stringify(r.state.userTags),tags);
  assert.ok(r.timers.length>0);
});
test('selected-example auto mode stores evidence; removing its source rejects stale auto results',async()=>{
  const r=await runtime(true);
  await r.ctx.audit.runLearningAnalysis();
  assert.ok(r.state.mutedUsers.includes('target'));assert.ok(r.state.learningAutoMutedUsers.includes('target'));
  const command=r.sent[0];assert.equal(command.entries[0].source,'selected-comments');assert.equal(command.entries[0].evidence.length,2);
  assert.ok(r.state.autoMuteLog[0].evidence.every(e=>e.sourceCommentKey));
  await r.ctx.ABEMAModerationStore.apply({type:'REMOVE_LEARNING_COMMENT',commentKey:r.state.learningSelectedSamples.samples[0].key});
  r.state.mutedUsers=[];r.state.learningAutoMutedUsers=[];
  const saved=await r.ctx.ABEMAModerationStore.apply(command);
  assert.equal(saved.count,0);assert.equal(r.state.mutedUsers.length,0);
});
test('selecting a missing or invalid comment cannot partially mutate storage',async()=>{
  const r=await runtime(false),before=JSON.stringify(r.state);
  await assert.rejects(()=>r.ctx.ABEMAModerationStore.apply({type:'SELECT_LEARNING_COMMENT',commentKey:'missing'}),/保存履歴/);
  assert.equal(JSON.stringify(r.state),before);
});
