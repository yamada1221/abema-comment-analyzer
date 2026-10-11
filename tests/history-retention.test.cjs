const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const background=fs.readFileSync(path.join(__dirname,'../background.js'),'utf8');
function harness(existing=[]) {
  const state={comments:structuredClone(existing)}, locks=new Map();
  let fail=false;
  const local={get:async()=>structuredClone(state),set:async update=>{
    if(fail){fail=false;throw new Error('temporary storage failure');}
    Object.assign(state,structuredClone(update));
  }};
  const worker=vm.createContext({chrome:{storage:{local}},navigator:{locks:{request:(name,fn)=>{
    const next=(locks.get(name)||Promise.resolve()).then(fn);locks.set(name,next.catch(()=>{}));return next;
  }}}});
  const start=background.indexOf('async function appendCapturedComments(');
  if(start>=0)vm.runInContext(background.slice(start,background.indexOf('\nfunction ',start)),worker);
  function tab(batch){
  const ctx=vm.createContext({SOURCE:'abema-comment-analyzer',queue:structuredClone(batch),flushing:false,contextValid:true,isContextValid:()=>true,invalidateContext:()=>false,moderation:{learningEnabled:false},chrome:{storage:{local},runtime:{sendMessage:async message=>{
    assert.equal(message.type,'APPEND_CAPTURED_COMMENTS');
    return worker.appendCapturedComments(message.comments);
  }}},console:{warn(){}}});
  if(source.includes('  const RETENTION_MS'))
  vm.runInContext(source.slice(source.indexOf('  const RETENTION_MS'),source.indexOf('  const DEFAULT_MODERATION')),ctx);
  vm.runInContext(source.slice(source.indexOf('  async function flush()'),source.indexOf('  function ',source.indexOf('  async function flush()'))),ctx);
  return ctx;
  }
  return {state,tab,failNext:()=>{fail=true;}};
}
async function save(existing,batch){
  const h=harness(existing);await h.tab(batch).flush();return h.state.comments;
}
const comment=id=>({id,userId:'u',message:id,createdAtMs:Date.now(),observedAt:Date.now()});
test('simultaneous tabs retain both batches instead of overwriting one another',async()=>{
  const h=harness([comment('old')]),a=h.tab([comment('a')]),b=h.tab([comment('b')]);
  await Promise.all([a.flush(),b.flush()]);
  assert.deepEqual(h.state.comments.map(c=>c.id).sort(),['a','b','old']);
});
test('failed writes are retried with newer arrivals and deduplicated after an uncertain acknowledgement',async()=>{
  const h=harness(),a=h.tab([comment('a')]);h.failNext();
  await a.flush();a.queue.push(comment('b'));await a.flush();
  assert.deepEqual(h.state.comments.map(c=>c.id),['a','b']);
  a.queue.push(h.state.comments[0]);await a.flush();
  assert.equal(h.state.comments.length,2);
});
test('disabled capture discards queued comments without retrying them later',async()=>{
  const h=harness([comment('old')]),a=h.tab([comment('discard')]);
  h.state.captureEnabled=false;await a.flush();h.state.captureEnabled=true;await a.flush();
  assert.deepEqual(h.state.comments.map(c=>c.id),['old']);
});
test('new capture retains seven-day-old history but expires observations older than 30 days',async()=>{
  const now=Date.now(),day=86400000;
  const result=await save([{id:'week',userId:'u',message:'week',createdAtMs:now-7*day,observedAt:now-7*day},{id:'expired',userId:'u',message:'old',createdAtMs:now-31*day,observedAt:now-31*day}],[{id:'new',userId:'u',message:'new',createdAtMs:now,observedAt:now}]);
  assert.deepEqual(Array.from(result,c=>c.id),['week','new']);
});
test('100000-comment cap retains the newest records and deduplicates IDs',async()=>{
 const now=Date.now();
 const existing=Array.from({length:100002},(_,i)=>({id:String(i),userId:'u',message:'sample',createdAtMs:now-200000+i,observedAt:now}));
 const result=await save(existing,[existing[100001]]);
 assert.equal(result.length,100000);assert.equal(result[0].id,'2');assert.equal(result.at(-1).id,'100001');
});
