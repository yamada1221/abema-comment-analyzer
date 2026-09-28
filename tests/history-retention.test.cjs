const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
async function save(existing,batch){
  let update;
  const ctx=vm.createContext({queue:batch,flushing:false,contextValid:true,isContextValid:()=>true,invalidateContext:()=>false,moderation:{learningEnabled:false},chrome:{storage:{local:{get:async()=>({comments:existing}),set:async d=>update=d}}},console});
  vm.runInContext(source.slice(source.indexOf('  const RETENTION_MS'),source.indexOf('  const DEFAULT_MODERATION')),ctx);
  vm.runInContext(source.slice(source.indexOf('  async function flush()'),source.indexOf('  function ',source.indexOf('  async function flush()'))),ctx);
  await ctx.flush();return update.comments;
}
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
