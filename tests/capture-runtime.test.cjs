const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(hidden=true) {
  const events={},messages=[],changes=[],writes=[];let fail=false,release;
  const document={hidden,title:'fixture',addEventListener:(type,fn)=>events[`document:${type}`]=fn};
  const window={addEventListener:(type,fn)=>events[type]=fn,postMessage(){}};
  const ctx=vm.createContext({console:{warn(){}},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},window,document,
    location:{href:'https://abema.tv/now-on-air/abema-news'},chrome:{runtime:{id:'test',
      onMessage:{addListener:fn=>messages.push(fn)},sendMessage:async message=>{
        if(release)await new Promise(resolve=>{release=resolve;});
        if(fail){fail=false;throw new Error('temporary failure');}
        writes.push(structuredClone(message));return {ok:true};
      }},storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener:fn=>changes.push(fn)}}}
  });
  vm.runInContext(source,ctx);await settle();
  return {document,writes,events,failNext:()=>fail=true,hold:()=>release=true,release:()=>{const fn=release;release=null;fn();},
    comment(id){events.message({source:window,data:{source:'abema-comment-analyzer',type:'COMMENT',payload:{id,userId:'u',message:id,createdAtMs:Date.now()}}});},
    disable(){changes.forEach(fn=>fn({captureEnabled:{newValue:false}},'local'));},
    enable(){changes.forEach(fn=>fn({captureEnabled:{newValue:true}},'local'));},
    heartbeat:()=>new Promise(resolve=>messages[0]({source:'abema-comment-analyzer',type:'CAPTURE_HEARTBEAT'},{},resolve))};
}
test('a single hidden-tab arrival saves without waiting for a throttled interval',async()=>{
  const h=await harness();h.comment('a');await settle();assert.equal(h.writes[0].comments[0].id,'a');
});
test('arrivals during a save drain even when all timers are suspended',async()=>{
  const h=await harness();h.hold();h.comment('a');await settle();h.comment('b');h.release();await settle();await settle();
  assert.deepEqual(h.writes.flatMap(message=>message.comments.map(c=>c.id)),['a','b']);
});
test('heartbeat retries a failed write and stopping capture clears queued data',async()=>{
  const h=await harness();h.failNext();h.comment('a');await settle();
  const result=await h.heartbeat();assert.equal(result.pending,0);assert.equal(h.writes[0].comments[0].id,'a');
  h.comment('b');h.disable();h.comment('ignored');await h.heartbeat();
  assert.equal(h.writes.length,1);
});
test('visibility and pagehide events flush small foreground queues',async()=>{
  const h=await harness(false);h.comment('first');await settle();h.comment('second');
  h.document.hidden=true;h.events['document:visibilitychange']();await settle();
  assert.ok(h.writes.some(message=>message.comments.some(c=>c.id==='second')));
  h.document.hidden=false;h.comment('third');h.events.pagehide();await settle();
  assert.ok(h.writes.some(message=>message.comments.some(c=>c.id==='third')));
});

test('a write that fails after recording is stopped cannot resurrect its batch on restart',async()=>{
  const h=await harness();h.hold();h.failNext();h.comment('a');await settle();h.disable();h.release();await settle();
  h.enable();await h.heartbeat();assert.equal(h.writes.length,0);
});
