const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../background-capture.js'),'utf8');
const url='https://abema.tv/now-on-air/abema-news';
function harness({enabled=true,existingAlarm=false}={}) {
  const local={captureEnabled:enabled},session={},tabs=new Map([
    [1,{id:1,url,autoDiscardable:true}],[2,{id:2,url,autoDiscardable:false}],
    [3,{id:3,url:'https://example.test/',autoDiscardable:true}]
  ]);
  const events={},alarms=new Map(existingAlarm?[['capture-watchdog',{periodInMinutes:1}]]:[]),created=[],sent=[];
  const event=key=>({addListener:fn=>(events[key]||=[]).push(fn)});
  const area=state=>({get:async key=>structuredClone({[key]:state[key]}),set:async data=>Object.assign(state,structuredClone(data))});
  const context=vm.createContext({console,setTimeout,clearTimeout,chrome:{
    storage:{local:area(local),session:area(session),onChanged:event('storage')},
    alarms:{get:async key=>alarms.get(key),create:async(key,value)=>{created.push(key);alarms.set(key,value);},onAlarm:event('alarm')},
    runtime:{onInstalled:event('installed'),onStartup:event('startup')},
    tabs:{query:async()=>structuredClone([...tabs.values()]),update:async(id,value)=>{Object.assign(tabs.get(id),value);},
      sendMessage:async(id,message)=>{sent.push({id,message});return {ok:true,pending:id};},onUpdated:event('updated'),onRemoved:event('removed')}
  }});
  vm.runInContext(source.replace(/\}\)\(\);\s*$/,'globalThis.audit={reconcile,setup};})();'),context);
  return {local,session,tabs,created,sent,events,reconcile:context.audit.reconcile};
}
test('capture protects only ABEMA tabs, restores original values on stop, and wakes content scripts',async()=>{
  const h=harness();await h.reconcile();
  assert.equal(h.tabs.get(1).autoDiscardable,false);assert.equal(h.tabs.get(2).autoDiscardable,false);
  assert.equal(h.tabs.get(3).autoDiscardable,true);
  assert.ok(h.sent.every(({message})=>message.type==='CAPTURE_HEARTBEAT'));
  assert.equal(h.local.backgroundCaptureStatus.connected,2);
  assert.equal(h.local.backgroundCaptureStatus.pending,3);
  h.local.captureEnabled=false;await h.reconcile();
  assert.equal(h.tabs.get(1).autoDiscardable,true);assert.equal(h.tabs.get(2).autoDiscardable,false);
  assert.equal(Object.keys(h.session.captureProtectedTabs).length,0);
});
test('watchdog releases navigated tabs and tolerates closed tabs while preserving its alarm',async()=>{
  const h=harness({existingAlarm:true});await h.reconcile();
  h.tabs.get(1).url='https://example.test/';await h.reconcile();
  assert.equal(h.tabs.get(1).autoDiscardable,true);assert.equal(h.created.length,0);
  h.tabs.get(1).url=url;await h.reconcile();h.tabs.delete(1);await h.reconcile();
  assert.equal(Object.keys(h.session.captureProtectedTabs).length,0);
});
test('disabled recording never protects or contacts tabs',async()=>{
  const h=harness({enabled:false});await h.reconcile();
  assert.equal(h.tabs.get(1).autoDiscardable,true);assert.equal(h.sent.length,0);
  assert.equal(h.local.backgroundCaptureStatus.enabled,false);
});
