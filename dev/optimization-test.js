"use strict";
// The download optimizations: resuming a broken piece from its received bytes, spreading
// pieces over nodes by measured speed, and growing sub-chunks with the measured speed.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=process.env.BTR_TEST_SOURCE
  ? path.resolve(process.env.BTR_TEST_SOURCE)
  : fs.existsSync(path.join(__dirname,"../shared/range-core.js"))?path.join(__dirname,"../shared"):path.join(__dirname,"../src");
// clock: what the downloader sees as performance (a test can move it ahead).
function load(clock=performance){
  const context=vm.createContext({URL,AbortController,DOMException,Response,ReadableStream,Headers,Uint8Array,Promise,setTimeout,clearTimeout,performance:clock,console});
  context.globalThis=context;
  context.__now=1e12;
  vm.runInContext("Date.now=()=>globalThis.__now;",context);
  for(const file of ["range-core.js","cdn-resolver.js","idm-downloader.js"])vm.runInContext(fs.readFileSync(path.join(SOURCE,file),"utf8"),context,{filename:file});
  return {core:context.__BILI_RANGE_CORE__,cdn:context.__BILI_CDN_RESOLVER_FACTORY__,idm:context.__BILI_IDM_DOWNLOADER_FACTORY__,advance:ms=>{context.__now+=ms;}};
}
const mediaUrl=host=>`https://${host}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&os=x`;
const pattern=(start,length)=>{const bytes=new Uint8Array(length);for(let i=0;i<length;i+=1)bytes[i]=(start+i)%251;return bytes;};
const rangeOf=init=>{const [,start,end]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);return {start,end,length:end-start+1};};
const ok=(start,end,total)=>new Response(pattern(start,end-start+1),{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${total}`}});

test("a broken transfer is resumed from its received bytes instead of downloaded again",{timeout:30000},async()=>{
  const {idm}=load();
  const BREAKS="upos-sz-mirrorali.bilivideo.com",RESCUES="upos-sz-mirrorhw.bilivideo.com";
  const TOTAL=8388608;
  const requests=[];
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    const {start,end}=rangeOf(init);
    requests.push({host,start,end});
    if(host===BREAKS){
      // Sends the first 96 KiB, then the connection breaks.
      let sent=0;
      const body=new ReadableStream({pull(controller){
        if(sent>=96*1024){controller.error(new Error("连接中断"));return;}
        controller.enqueue(pattern(start+sent,32*1024));
        sent+=32*1024;
      }});
      return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${TOTAL}`}});
    }
    return ok(start,end,TOTAL);
  };
  const only=[mediaUrl(BREAKS),mediaUrl(RESCUES)];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only.slice(1),rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  // One piece only: the whole range is one 512 KiB sub-chunk.
  const range={start:1000,end:1000+512*1024-1,length:512*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video",maxConcurrency:1});
  assert.equal(result.bytes.length,range.length);
  assert.ok(result.bytes.every((value,i)=>value===(range.start+i)%251),"spliced bytes are positioned correctly");
  const rescue=requests.filter(item=>item.host===RESCUES);
  assert.equal(rescue.length,1);
  assert.equal(rescue[0].start,range.start+96*1024,"the rescue request asked only for the missing tail");
  assert.equal(rescue[0].end,range.end);
});

test("pieces are spread over nodes by measured speed",{timeout:30000},async()=>{
  const {cdn,idm}=load();
  const FAST="upos-sz-mirrorali.bilivideo.com",SLOW="upos-sz-mirrorhw.bilivideo.com";
  const counts=new Map();
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    counts.set(host,(counts.get(host)||0)+1);
    const {start,end}=rangeOf(init);
    return ok(start,end,67108864);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:32,mode:"custom",customHosts:[FAST,SLOW]}),nativeFetch});
  const resolver=cdn.createResolver({baseUrl:mediaUrl(FAST)},()=> "custom",null,()=>[FAST,SLOW]);
  // Health as if the fast node had been measured nine times faster.
  resolver.success(mediaUrl(FAST),9*1024*1024);
  resolver.success(mediaUrl(SLOW),1*1024*1024);
  const range={start:0,end:2*1024*1024-1,length:2*1024*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});
  assert.equal(result.bytes.length,range.length);
  assert.ok((counts.get(FAST)||0)>=(counts.get(SLOW)||0)*2,
    `the fast node carries most pieces: fast ${counts.get(FAST)} vs slow ${counts.get(SLOW)}`);
  assert.ok((counts.get(SLOW)||0)>=1,"the slow node keeps a floor share");
});

test("sub-chunks grow with the measured connection speed, but a range keeps at least four pieces",{timeout:30000},async()=>{
  const {idm}=load();
  const HOST="upos-sz-mirrorali.bilivideo.com";
  let requests=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    requests.push(end-start+1);
    return ok(start,end,67108864);
  };
  const only=[mediaUrl(HOST)];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only,rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:32}),nativeFetch});
  // The first range is measured with 64 KiB chunks (instant responses look very fast here).
  const first={start:0,end:2*1024*1024-1,length:2*1024*1024};
  await downloader.downloadRange(first,resolver,{parallel:true,kind:"video"});
  const firstCounts=requests.length;
  assert.ok(firstCounts>=16,`the unmeasured range splits small: ${firstCounts} pieces`);
  requests=[];
  const second={start:4*1024*1024,end:6*1024*1024-1,length:2*1024*1024};
  await downloader.downloadRange(second,resolver,{parallel:true,kind:"video"});
  assert.ok(requests.length<firstCounts,`the measured range uses larger pieces: ${requests.length} < ${firstCounts}`);
  assert.ok(requests.length>=4,`the spread over nodes keeps at least four pieces: ${requests.length}`);
  assert.ok(Math.max(...requests)<=1024*1024,"a sub-chunk never exceeds 1 MiB");
});

test("the short tail of a resumed piece is not taken for the speed of the node that fetched it",{timeout:30000},async()=>{
  const {cdn,idm}=load();
  const BREAKS="upos-sz-mirrorali.bilivideo.com",RESCUES="upos-sz-mirrorhw.bilivideo.com";
  const TOTAL=8388608;
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    const {start,end}=rangeOf(init);
    if(host!==BREAKS)return ok(start,end,TOTAL);
    // Sends all but the last 8 KiB, then the connection breaks.
    const stop=end-start+1-8*1024;
    let sent=0;
    const body=new ReadableStream({pull(controller){
      if(sent>=stop){controller.error(new Error("连接中断"));return;}
      const size=Math.min(32*1024,stop-sent);
      controller.enqueue(pattern(start+sent,size));
      sent+=size;
    }});
    return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${TOTAL}`}});
  };
  const only=[mediaUrl(BREAKS),mediaUrl(RESCUES)];
  const reported=[];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only.slice(1),rangeCandidates:()=>only,allows:()=>true,success(url,bps){reported.push({host:new URL(url).hostname,bps});},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  const range={start:1000,end:1000+256*1024-1,length:256*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video",maxConcurrency:1});
  assert.ok(result.bytes.every((value,i)=>value===(range.start+i)%251),"spliced bytes are positioned correctly");
  assert.deepEqual(reported,[{host:RESCUES,bps:0}],"the node that fetched the 8 KiB tail is reported as working, without a speed");
});

test("pieces go to the nodes in turns, and ranges in flight together open on different nodes",{timeout:30000},async()=>{
  const {cdn,idm}=load();
  const HOSTS=["upos-sz-mirrorali.bilivideo.com","upos-sz-mirrorhw.bilivideo.com","upos-sz-mirrorbos.bilivideo.com","upos-sz-mirror08c.bilivideo.com"];
  const order=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    order.push({host:new URL(url).hostname,start});
    return ok(start,end,67108864);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:64}),nativeFetch});
  // Four nodes measured equally fast, and staying so.
  const all=HOSTS.map(mediaUrl);
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all,rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>4*1024*1024};
  const first=[];
  for(let index=0;index<3;index+=1){
    order.length=0;
    const start=index*1024*1024;
    await downloader.downloadRange({start,end:start+512*1024-1,length:512*1024},resolver,{parallel:true,kind:"video"});
    const pieces=order.slice().sort((a,b)=>a.start-b.start).map(item=>item.host);
    // Equal nodes: no node gets two pieces in a row, and each gets its share.
    assert.ok(pieces.every((host,i)=>i===0||host!==pieces[i-1]),`neighbouring pieces use different nodes: ${pieces.join(" ")}`);
    assert.equal(new Set(pieces.slice(0,HOSTS.length)).size,HOSTS.length,"the first pieces cover every node");
    first.push(pieces[0]);
  }
  assert.equal(new Set(first).size,3,`each range opens on another node: ${first.join(" ")}`);
});

test("a measurement goes stale, and the slow node gets another try through the exploration slot",()=>{
  const {cdn,advance}=load();
  const HOSTS=["upos-sz-mirrorali.bilivideo.com","upos-sz-mirrorhw.bilivideo.com","upos-sz-mirrorbos.bilivideo.com","upos-sz-mirror08c.bilivideo.com","upos-sz-mirrorbd.bilivideo.com","upos-sz-mirror14b.bilivideo.com","upos-sz-estgoss.bilivideo.com","upos-sz-mirrorcos.bilivideo.com"];
  const resolver=cdn.createResolver({baseUrl:mediaUrl(HOSTS[0])},()=> "mainland");
  const SLOW=mediaUrl(HOSTS[7]);
  HOSTS.forEach((host,index)=>resolver.success(mediaUrl(host),(8-index)*1024*1024));
  resolver.rangeCandidates(); // the warm-up range uses every node
  // The six fastest keep being used and measured; the slowest is outside them.
  const triedAt=[];
  for(let seconds=20;seconds<=160;seconds+=20){
    advance(20000);
    const picked=resolver.rangeCandidates();
    assert.equal(picked.length,6);
    if(picked.includes(SLOW))triedAt.push(seconds);
    for(const url of picked)resolver.success(url,resolver.speed(url)||1024*1024);
  }
  assert.ok(triedAt.length>=1,"the slow node is tried again");
  assert.ok(triedAt[0]>=90,`but not while its measurement is fresh: first tried after ${triedAt[0]} s`);
  assert.ok(triedAt.length<=2,`and one try measures it for another 90 seconds: tried at ${triedAt.join(", ")} s`);
  assert.ok(resolver.speed(SLOW)>0,"it has a fresh measurement again");
});

test("a fresh signature keeps the measured speed of a node, but not the failures of the old address",()=>{
  const {cdn}=load();
  const HOST="upos-sz-mirrorali.bilivideo.com";
  const representation={baseUrl:`https://${HOST}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&upsig=old`};
  const resolver=cdn.createResolver(representation,()=> "mainland");
  const old=resolver.urls().find(url=>new URL(url).hostname===HOST);
  resolver.success(old,5000000);
  resolver.failure(old,new Error("HTTP 403"),0);
  representation.baseUrl=`https://${HOST}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=2&upsig=new`;
  const fresh=resolver.urls().find(url=>new URL(url).hostname===HOST);
  assert.notEqual(fresh,old);
  assert.equal(resolver.speed(fresh),5000000,"the node's speed is known at once");
  assert.ok(resolver.rangeCandidates().includes(fresh),"the new address is not backing off for the old one's failure");
});

test("short transfers do not keep an old speed measurement alive",()=>{
  const {cdn,advance}=load();
  const URL_A=mediaUrl("upos-sz-mirrorali.bilivideo.com");
  const resolver=cdn.createResolver({baseUrl:URL_A},()=> "mainland");
  resolver.success(URL_A,5000000);
  for(let seconds=0;seconds<100;seconds+=20){advance(20000);resolver.success(URL_A,0);}
  assert.equal(resolver.speed(URL_A),0,"after 90 seconds without a real measurement the speed counts as unknown");
  assert.equal(resolver.status().find(item=>item.host==="upos-sz-mirrorali.bilivideo.com").state,"healthy","the node itself is known to work");
  resolver.success(URL_A,3000000);
  assert.ok(resolver.speed(URL_A)>0,"a real measurement brings it back");
});

test("small segments still give an unmeasured node a piece now and then",{timeout:30000},async()=>{
  const {idm}=load();
  const KNOWN="upos-sz-mirrorali.bilivideo.com",STALE="upos-sz-mirrorhw.bilivideo.com";
  const counts=new Map();
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    counts.set(host,(counts.get(host)||0)+1);
    const {start,end}=rangeOf(init);
    return ok(start,end,67108864);
  };
  const all=[mediaUrl(KNOWN),mediaUrl(STALE)];
  // One node is measured, the other's measurement has gone stale; 128 KiB ranges are two pieces.
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all,rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:url=>url===all[0]?4*1024*1024:0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  for(let index=0;index<12;index+=1){
    const start=index*1024*1024;
    await downloader.downloadRange({start,end:start+128*1024-1,length:128*1024},resolver,{parallel:true,kind:"audio"});
  }
  assert.ok((counts.get(STALE)||0)>=2,`the unmeasured node was tried: ${counts.get(STALE)||0} requests`);
  assert.ok((counts.get(STALE)||0)<=4,`but only now and then: ${counts.get(STALE)||0} of ${(counts.get(KNOWN)||0)+(counts.get(STALE)||0)} requests`);
});

test("a copy that lost the race still measures its node",{timeout:30000},async()=>{
  const {idm}=load();
  const SLOW="upos-sz-mirrorali.bilivideo.com",FAST="upos-sz-mirrorhw.bilivideo.com";
  const TOTAL=8388608;
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    const {start,end}=rangeOf(init);
    if(host!==SLOW)return ok(start,end,TOTAL);
    // 32 KiB every 40 ms: far too slow to finish before the second copy does.
    let sent=0;
    const body=new ReadableStream({async pull(controller){
      await new Promise(resolve=>setTimeout(resolve,40));
      if(init.signal.aborted){controller.error(new DOMException("aborted","AbortError"));return;}
      controller.enqueue(pattern(start+sent,32*1024));
      sent+=32*1024;
    }});
    return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${TOTAL}`}});
  };
  const only=[mediaUrl(SLOW),mediaUrl(FAST)];
  const reported=[];
  const succeeded=[];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only.slice(1),rangeCandidates:()=>only,allows:()=>true,success(url){succeeded.push(new URL(url).hostname);},sample(url,bps){reported.push({host:new URL(url).hostname,bps});},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  const range={start:0,end:2*1024*1024-1,length:2*1024*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video",maxConcurrency:1});
  assert.ok(result.bytes.every((value,i)=>value===i%251),"the bytes are right whichever copy delivered them");
  const slow=reported.filter(item=>item.host===SLOW);
  assert.equal(slow.length,1,"the slow node is measured although its copy was cut off");
  assert.ok(slow[0].bps>0&&slow[0].bps<2*1024*1024,`with the speed it really had: ${Math.round(slow[0].bps/1024)} KiB/s`);
  assert.ok(!succeeded.includes(SLOW),"a cut-off transfer is a speed sample, not a success");
});

test("a speed sample measures a node without forgiving its failures",()=>{
  const {cdn}=load();
  const URL_A=mediaUrl("upos-sz-mirrorali.bilivideo.com");
  const resolver=cdn.createResolver({baseUrl:URL_A},()=> "mainland");
  resolver.failure(URL_A,new Error("CDN 子块停止传输"),4096);
  assert.ok(!resolver.rangeCandidates().includes(URL_A),"the address backs off after the failure");
  resolver.sample(URL_A,300000);
  assert.equal(resolver.speed(URL_A),300000,"the sample is its measured speed");
  assert.ok(!resolver.rangeCandidates().includes(URL_A),"and it is still backing off");
  assert.equal(resolver.status().find(item=>item.host==="upos-sz-mirrorali.bilivideo.com").state,"blocked");
});

test("the video and the audio track each get their trials, however they take turns",{timeout:30000},async()=>{
  const {idm}=load();
  const KNOWN="upos-sz-mirrorali.bilivideo.com",STALE="upos-sz-mirrorhw.bilivideo.com";
  const counts={video:0,audio:0};
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    if(new URL(url).hostname===STALE)counts[url.includes("30280")?"audio":"video"]+=1;
    return ok(start,end,67108864);
  };
  const track=file=>{
    const all=[KNOWN,STALE].map(host=>`https://${host}/upgcxcode/00/00/1/${file}.m4s?deadline=1&os=x`);
    return {urls:()=>all,ordered:()=>all,rescueCandidates:()=>all,rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:url=>url===all[0]?4*1024*1024:0};
  };
  const video=track("1-1-30080"),audio=track("1-1-30280");
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  for(let index=0;index<12;index+=1){
    const start=index*1024*1024;
    await downloader.downloadRange({start,end:start+128*1024-1,length:128*1024},video,{parallel:true,kind:"video"});
    await downloader.downloadRange({start,end:start+128*1024-1,length:128*1024},audio,{parallel:true,kind:"audio"});
  }
  assert.ok(counts.video>=2&&counts.audio>=2,`both tracks tried their unmeasured node: video ${counts.video}, audio ${counts.audio}`);
});

test("a normal range leaves one connection slot for a stalled piece to change node",{timeout:30000},async()=>{
  const {idm}=load();
  const A="upos-sz-mirrorali.bilivideo.com",B="upos-sz-mirrorhw.bilivideo.com",all=[mediaUrl(A),mediaUrl(B)];
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>0};
  const pending=[],requests=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    requests.push({start,end,at:Date.now(),host:new URL(url).hostname});
    await new Promise(resolve=>pending.push(resolve));
    return ok(start,end,64*1024*1024);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const normal=downloader.downloadRange({start:0,end:8*64*1024-1,length:8*64*1024},resolver,{parallel:true,kind:"video"});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(requests.length,7,"seven primary pieces leave one rescue slot at concurrency eight");
  await new Promise(resolve=>setTimeout(resolve,950));
  assert.equal(requests.length,8,"a hedge uses the spare slot before the 5.5 second first-byte timeout");
  const drain=setInterval(()=>{while(pending.length)pending.shift()();},10);
  await normal;
  clearInterval(drain);
});

test("an expired deadline does not blindly fan out to every piece",{timeout:30000},async()=>{
  const {idm}=load();
  const A="upos-sz-mirrorali.bilivideo.com",B="upos-sz-mirrorhw.bilivideo.com",all=[mediaUrl(A),mediaUrl(B)],starts=[],pending=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    starts.push({start,host:new URL(url).hostname,at:Date.now()});
    await new Promise(resolve=>pending.push({start,resolve}));
    return ok(start,end,64*1024*1024);
  };
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const task=downloader.downloadRange({start:0,end:8*64*1024-1,length:8*64*1024},resolver,{parallel:true,kind:"video",deadlineMs:0});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(starts.length,7,"an expired deadline does not immediately duplicate every piece");
  await new Promise(resolve=>setTimeout(resolve,240));
  assert.equal(starts.length,7,"deadline alone does not duplicate any piece before it proves slow");
  const ordinary=pending[0];
  pending.splice(pending.indexOf(ordinary),1);
  ordinary.resolve();
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(starts.length,7,"freeing a slot still does not trigger deadline-only duplication");
  const drain=setInterval(()=>{while(pending.length)pending.shift().resolve();},10);
  await task;
  clearInterval(drain);
});

test("progress ETA gives one measured straggler the rescue slot before the fixed delay",{timeout:30000},async()=>{
  const {idm}=load(),A="upos-sz-mirrorali.bilivideo.com",B="upos-sz-mirrorhw.bilivideo.com",all=[mediaUrl(A),mediaUrl(B)];
  const seen=new Map(),starts=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init),length=end-start+1,count=(seen.get(start)||0)+1;
    seen.set(start,count);starts.push({start,count,at:Date.now()});
    if(start>=60*1024*1024){
      await new Promise(resolve=>setTimeout(resolve,600));
      return ok(start,end,128*1024*1024);
    }
    if(count>1)return ok(start,end,128*1024*1024);
    let firstTimer,finishTimer;
    const body=new ReadableStream({
      start(controller){
        firstTimer=setTimeout(()=>controller.enqueue(new Uint8Array(8*1024)),300);
        finishTimer=setTimeout(()=>{controller.enqueue(new Uint8Array(length-8*1024));controller.close();},1000);
        init.signal?.addEventListener("abort",()=>{clearTimeout(firstTimer);clearTimeout(finishTimer);try{controller.error(new DOMException("aborted","AbortError"));}catch(_error){}},{once:true});
      },
      cancel(){clearTimeout(firstTimer);clearTimeout(finishTimer);}
    });
    return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${64*1024*1024}`}});
  };
  const fastResolver={urls:()=>[all[0]],ordered:()=>[all[0]],rescueCandidates:()=>[],rangeCandidates:()=>[all[0]],allows:()=>true,success(){},failure(){},speed:()=>0};
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const warmStart=60*1024*1024,warmLength=1024*1024;
  await downloader.downloadRange({start:warmStart,end:warmStart+warmLength-1,length:warmLength},fastResolver,{parallel:true,kind:"video",maxConcurrency:1});
  const began=Date.now();
  await downloader.downloadRange({start:0,end:8*64*1024-1,length:8*64*1024},resolver,{parallel:true,kind:"video",deadlineMs:0});
  const rescue=starts.find(item=>item.start>=0&&item.count===2);
  assert.ok(rescue&&rescue.at-began>=200&&rescue.at-began<700,`ETA rescue starts after grace and before fixed delay: ${rescue?.at-began}ms`);
});

test("two sustained deadline deficits rescue a uniformly slow route",{timeout:30000},async()=>{
  const {idm}=load(),A="upos-sz-mirrorali.bilivideo.com",B="upos-sz-mirrorhw.bilivideo.com",all=[mediaUrl(A),mediaUrl(B)];
  const seen=new Map(),starts=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init),length=end-start+1,count=(seen.get(start)||0)+1;
    seen.set(start,count);starts.push({start,count,at:Date.now()});
    if(start>=60*1024*1024){
      await new Promise(resolve=>setTimeout(resolve,1000));
      return ok(start,end,128*1024*1024);
    }
    if(count>1)return ok(start,end,128*1024*1024);
    let firstTimer,secondTimer,finishTimer;
    const body=new ReadableStream({
      start(controller){
        firstTimer=setTimeout(()=>controller.enqueue(new Uint8Array(8*1024)),200);
        secondTimer=setTimeout(()=>controller.enqueue(new Uint8Array(8*1024)),300);
        finishTimer=setTimeout(()=>{controller.enqueue(new Uint8Array(length-16*1024));controller.close();},1000);
        init.signal?.addEventListener("abort",()=>{clearTimeout(firstTimer);clearTimeout(secondTimer);clearTimeout(finishTimer);try{controller.error(new DOMException("aborted","AbortError"));}catch(_error){}},{once:true});
      },
      cancel(){clearTimeout(firstTimer);clearTimeout(secondTimer);clearTimeout(finishTimer);}
    });
    return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${128*1024*1024}`}});
  };
  const warmResolver={urls:()=>[all[0]],ordered:()=>[all[0]],rescueCandidates:()=>[],rangeCandidates:()=>[all[0]],allows:()=>true,success(){},failure(){},speed:()=>0};
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const warmStart=60*1024*1024,warmLength=64*1024;
  await downloader.downloadRange({start:warmStart,end:warmStart+warmLength-1,length:warmLength},warmResolver,{parallel:true,kind:"video",maxConcurrency:1});
  const began=Date.now();
  await downloader.downloadRange({start:0,end:8*64*1024-1,length:8*64*1024},resolver,{parallel:true,kind:"video",deadlineMs:0});
  const rescue=starts.find(item=>item.start<warmStart&&item.count===2);
  assert.ok(rescue&&rescue.at-began>=250&&rescue.at-began<700,`sustained deficit rescue starts before fixed delay: ${rescue?.at-began}ms`);
});

test("an overdue primary gets a bounded boost over prefetch work",{timeout:30000},async()=>{
  const {idm}=load(),HOST="upos-sz-mirrorali.bilivideo.com",only=[mediaUrl(HOST)],pending=[],starts=[];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only,rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const nativeFetch=async(_url,init)=>{const range=rangeOf(init);starts.push(range.start);await new Promise(resolve=>pending.push(resolve));return ok(range.start,range.end,128*1024*1024);};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  const blocker=downloader.downloadRange({start:0,end:4*64*1024-1,length:4*64*1024},resolver,{parallel:true,kind:"video",priority:100});
  await new Promise(resolve=>setTimeout(resolve,20));
  const farStart=8*1024*1024,overdueStart=16*1024*1024;
  const far=downloader.downloadRange({start:farStart,end:farStart+64*1024-1,length:64*1024},resolver,{parallel:true,kind:"video",priority:60});
  const overdue=downloader.downloadRange({start:overdueStart,end:overdueStart+64*1024-1,length:64*1024},resolver,{parallel:true,kind:"video",priority:50,deadlineMs:0});
  pending.shift()();
  for(let tick=0;starts.length<5&&tick<100;tick+=1)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(starts[4],overdueStart,"the capped deadline boost beats prefetch without strict EDF");
  const drain=setInterval(()=>{while(pending.length)pending.shift()();},10);
  await Promise.all([blocker,far,overdue]);
  clearInterval(drain);
});

test("one absolute deadline is shared by the startup probe and its tail pieces",{timeout:30000},async()=>{
  const {idm}=load();
  const A="upos-sz-mirrorali.bilivideo.com",B="upos-sz-mirrorhw.bilivideo.com",all=[mediaUrl(A),mediaUrl(B)],deadlines=[];
  const nativeFetch=async(url,init)=>{
    const range=rangeOf(init);
    await new Promise(resolve=>setTimeout(resolve,range.start===0?80:5));
    return ok(range.start,range.end,128*1024*1024);
  };
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch,onTransfer:event=>{if(event.phase==="start"&&event.deadlineAt)deadlines.push(event.deadlineAt);return deadlines.length;}});
  await downloader.downloadRange({start:0,end:8*64*1024-1,length:8*64*1024},resolver,{parallel:true,startup:true,kind:"video",deadlineMs:1000,onOrderedChunk:async()=>{}});
  assert.ok(deadlines.length>2,"probe and tail requests were observed");
  assert.equal(new Set(deadlines.map(Math.round)).size,1,"all pieces keep the deadline fixed at range entry");
});

test("metadata priority stays ahead of media regardless of media deadlines",{timeout:30000},async()=>{
  const {idm}=load(),HOST="upos-sz-mirrorali.bilivideo.com",only=[mediaUrl(HOST)],pending=[],requests=[];
  const resolver={urls:()=>only,ordered:()=>only,startupCandidates:()=>only,rescueCandidates:()=>only,rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const nativeFetch=async(_url,init)=>{const range=rangeOf(init);requests.push(range.start);await new Promise(resolve=>pending.push(resolve));return ok(range.start,range.end,128*1024*1024);};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  const blocker=downloader.downloadRange({start:0,end:4*64*1024-1,length:4*64*1024},resolver,{parallel:true,kind:"video",priority:50,deadlineMs:0});
  await new Promise(resolve=>setTimeout(resolve,20));
  const mediaStart=8*64*1024,metaStart=64*1024*1024;
  const media=downloader.downloadRange({start:mediaStart,end:mediaStart+64*1024-1,length:64*1024},resolver,{parallel:true,kind:"video",priority:120,deadlineMs:0});
  const meta=downloader.downloadRange({start:metaStart,end:metaStart+1023,length:1024},resolver,{parallel:false,kind:"meta"});
  pending.shift()();
  for(let tick=0;requests.length<5&&tick<100;tick+=1)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(requests[4],metaStart,"priority 220 metadata starts before deadline-bearing media");
  const drain=setInterval(()=>{while(pending.length)pending.shift()();},10);
  await Promise.all([blocker,media,meta]);
  clearInterval(drain);
});

test("a second copy waits until the first copy has a connection",{timeout:30000},async()=>{
  // A piece the player needs now (deadline 0). All eight connections held by other ranges for
  // 1.5 s. The queued piece's second copy used to
  // count its delay from the queue and then took the connection before its own first copy.
  const {idm}=load();
  const HOLD="upos-sz-mirrorbos.bilivideo.com",FIRST="upos-sz-mirrorali.bilivideo.com",SECOND="upos-sz-mirrorhw.bilivideo.com";
  const requests=[];
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname,{start,end}=rangeOf(init);
    requests.push(host);
    if(host===HOLD) await new Promise(resolve=>setTimeout(resolve,1500));
    return ok(start,end,64*1024*1024);
  };
  const single=[mediaUrl(HOLD)],pair=[mediaUrl(FIRST),mediaUrl(SECOND)];
  const resolverOf=urls=>({urls:()=>urls,ordered:()=>urls,rescueCandidates:()=>urls.slice(1),rangeCandidates:()=>urls,allows:()=>true,success(){},failure(){},speed:()=>0});
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const held=Promise.all(Array.from({length:8},(_,index)=>downloader.downloadRange({start:index*64*1024,end:(index+1)*64*1024-1,length:64*1024},resolverOf(single),{parallel:true,kind:"video",maxConcurrency:1})));
  await new Promise(resolve=>setTimeout(resolve,20));
  const queued=downloader.downloadRange({start:0,end:64*1024-1,length:64*1024},resolverOf(pair),{parallel:true,kind:"video",maxConcurrency:1,deadlineMs:0});
  await Promise.all([held,queued]);
  assert.deepEqual(requests,[...Array(8).fill(HOLD),FIRST],"the queued piece started with its first copy and needed no second one");
});

test("a piece well on time for playback gets no second copy, a late one does",{timeout:30000},async()=>{
  // The first copy keeps sending 8 KiB every 200 ms: 64 KiB in about 1.4 s.
  const {idm}=load();
  const FIRST="upos-sz-mirrorali.bilivideo.com",SECOND="upos-sz-mirrorhw.bilivideo.com";
  const all=[mediaUrl(FIRST),mediaUrl(SECOND)];
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>0};
  async function run(deadlineMs){
    const requests=[];
    const nativeFetch=async(url,init)=>{
      const host=new URL(url).hostname,{start,end}=rangeOf(init);
      requests.push(host);
      if(host!==FIRST) return ok(start,end,64*1024*1024);
      return stepped(start,end,[[8*1024,0],...Array(7).fill([8*1024,200])],init.signal);
    };
    const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
    const result=await downloader.downloadRange({start:0,end:64*1024-1,length:64*1024},resolver,{parallel:true,kind:"video",maxConcurrency:1,deadlineMs});
    assert.equal(result.bytes.length,64*1024);
    return requests;
  }
  assert.deepEqual(await run(20000),[FIRST],"due in 20 s and arriving in about 2 s: no copy");
  assert.deepEqual(await run(1000),[FIRST,SECOND],"due in 1 s: the copy starts");
  assert.deepEqual(await run(undefined),[FIRST,SECOND],"no deadline: the copy starts after the usual delay");
});

// A 206 body sent in steps: [[byte count, ms after the previous step], ...]; the rest never comes.
function stepped(start,end,steps,signal){
  const bytes=pattern(start,end-start+1),timers=[];
  const body=new ReadableStream({start(controller){
    let sent=0,at=0;
    for(const [count,after] of steps){
      at+=after;
      const from=sent,to=Math.min(bytes.length,sent+count);sent=to;
      timers.push(setTimeout(()=>{try{controller.enqueue(bytes.slice(from,to));if(to>=bytes.length)controller.close();}catch(_){}} ,at));
    }
  },cancel(){timers.forEach(clearTimeout);}});
  signal?.addEventListener("abort",()=>timers.forEach(clearTimeout),{once:true});
  return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${64*1024*1024}`}});
}

test("a piece on pace gets a copy only on a node known to be faster or not measured yet",{timeout:30000},async()=>{
  // A piece due in 2.4 s that needs about 1.6 s: close enough that the deadline alone does
  // not decide, with every connection taken.
  const {idm}=load();
  const FIRST="upos-sz-mirrorali.bilivideo.com",SECOND="upos-sz-mirrorhw.bilivideo.com",HOLD="upos-sz-mirrorbos.bilivideo.com";
  const holdersGone=new AbortController();
  const all=[mediaUrl(FIRST),mediaUrl(SECOND)];
  let copySpeed=0;
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},
    // Both nodes report the same measured speed, so whichever carries the copy has it.
    speed:()=>copySpeed};
  let mode="warm";
  const requests=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    if(new URL(url).hostname===HOLD) return new Promise((resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new DOMException("gone","AbortError")),{once:true}));
    requests.push(new URL(url).hostname);
    // The first request of each download is its first copy; a later one is the copy. The copy
    // runs at the usual speed too, so the first copy finishes first and the measured usual
    // speed stays what it was.
    if(requests.length>1) return stepped(start,end,[[8*1024,0],...Array(15).fill([8*1024,200])],init.signal);
    // Warm-up: 64 KiB in 1.5 s, so connections usually run at about 43 KiB/s.
    if(mode==="warm") return stepped(start,end,[[16*1024,0],[16*1024,500],[16*1024,500],[16*1024,500]],init.signal);
    // Steady 8 KiB every 200 ms, about 40 KiB/s: the usual speed.
    if(mode==="pace") return stepped(start,end,[[8*1024,0],...Array(7).fill([8*1024,200])],init.signal);
    // 4 KiB every 200 ms, about 20 KiB/s: well below the usual speed.
    return stepped(start,end,[[4*1024,0],...Array(15).fill([4*1024,200])],init.signal);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  const piece=index=>({start:index*64*1024,end:(index+1)*64*1024-1,length:64*1024});
  // Warm-up on one node only, so no copy finishes it faster than the usual speed.
  const alone={...resolver,urls:()=>all.slice(0,1),ordered:()=>all.slice(0,1),rescueCandidates:()=>[],rangeCandidates:()=>all.slice(0,1)};
  for(const index of [0,1]){
    requests.length=0;
    await downloader.downloadRange(piece(index),alone,{parallel:true,kind:"video",maxConcurrency:1});
  }
  // Three of the four connections stay taken (cancelled, never completed: a completed one
  // would change the measured usual speed); the piece takes the fourth.
  const held=[mediaUrl(HOLD)],holder={...resolver,urls:()=>held,ordered:()=>held,rescueCandidates:()=>[],rangeCandidates:()=>held,speed:()=>0};
  const holders=[10,11,12].map(index=>downloader.downloadRange(piece(index),holder,{parallel:true,kind:"video",maxConcurrency:1,signal:holdersGone.signal}).catch(()=>{}));
  await new Promise(resolve=>setTimeout(resolve,20));
  async function run(index,nextMode,speed){
    mode=nextMode;copySpeed=speed;requests.length=0;
    await downloader.downloadRange(piece(index),resolver,{parallel:true,kind:"video",maxConcurrency:1,deadlineMs:2400});
    return requests.length;
  }
  assert.equal(await run(2,"pace",40*1024),1,"on pace, the copy's node known to be as fast: no copy");
  assert.equal(await run(3,"pace",120*1024),2,"on pace, the copy's node known to be three times faster than this first copy: copy");
  assert.equal(await run(4,"pace",0),2,"on pace, the copy's node not measured yet: copy");
  assert.equal(await run(5,"slow",40*1024),2,"half the usual speed: copy");
  holdersGone.abort();
  await Promise.all(holders);
});

test("a deadline that moves closer while a piece downloads still brings its copy",{timeout:30000},async()=>{
  // The player passes the time left as a function. The segment plays at 20 s; the playhead
  // runs at 1x, then at 3x from 1.2 s on. The first copy keeps sending 4 KiB every 100 ms and
  // needs about 6.4 s for its 256 KiB: plenty of time at 1x, too late at 3x.
  const {idm}=load();
  const FIRST="upos-sz-mirrorali.bilivideo.com",SECOND="upos-sz-mirrorhw.bilivideo.com";
  const all=[mediaUrl(FIRST),mediaUrl(SECOND)];
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>0};
  const requests=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    requests.push({host:new URL(url).hostname,at:Date.now()-began});
    if(requests.length>1) return ok(start,end,64*1024*1024);
    return stepped(start,end,[[4*1024,0],...Array(63).fill([4*1024,100])],init.signal);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const began=Date.now();
  const playhead=()=>{const t=(Date.now()-began)/1000;return t<1.2?t:1.2+(t-1.2)*3;};
  const left=()=>Math.max(0,20-playhead())*1000/((Date.now()-began)<1200?1:3);
  await downloader.downloadRange({start:0,end:256*1024-1,length:256*1024},resolver,{parallel:true,kind:"video",maxConcurrency:1,deadlineMs:left});
  assert.equal(requests.length,2,"the copy starts");
  assert.ok(requests[1].at>=1150,`no copy while the deadline was far: ${requests[1].at} ms`);
  assert.ok(Date.now()-began<3000,`finished long before the first copy would have: ${Date.now()-began} ms`);
});

test("an instant answer to the startup probe stops the other candidates before they ask",{timeout:30000},async()=>{
  const {idm}=load();
  const hosts=["upos-sz-mirrorali.bilivideo.com","upos-sz-mirrorhw.bilivideo.com","upos-sz-mirrorbos.bilivideo.com","upos-sz-mirror08c.bilivideo.com"];
  const all=hosts.map(mediaUrl),requests=[];
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,startupCandidates:()=>all,allows:()=>true,success(){},failure(){},speed:()=>0};
  const nativeFetch=async(url,init)=>{const {start,end}=rangeOf(init);requests.push(new URL(url).hostname);return ok(start,end,64*1024*1024);};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  await downloader.downloadRange({start:0,end:64*1024-1,length:64*1024},resolver,{parallel:true,kind:"video",startup:true,onOrderedChunk:async()=>{}});
  assert.equal(requests.length,1,`probe requests: ${requests.join(", ")}`);
});

test("a player request that has waited long goes before a newer one of slightly higher priority",{timeout:30000},async()=>{
  // Only requests with a playback deadline age; the ones here are due in 30 s.
  const {idm}=load();
  const HOST="upos-sz-mirrorali.bilivideo.com",only=[mediaUrl(HOST)];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>[],rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const started=[],pending=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    started.push(start);
    await new Promise(resolve=>pending.push(resolve));
    return ok(start,end,64*1024*1024);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const piece=index=>({start:index*64*1024,end:(index+1)*64*1024-1,length:64*1024});
  const busy=Array.from({length:8},(_,index)=>downloader.downloadRange(piece(index),resolver,{parallel:true,kind:"video",maxConcurrency:1,priority:50}));
  await new Promise(resolve=>setTimeout(resolve,20));
  const old=downloader.downloadRange(piece(20),resolver,{parallel:true,kind:"video",maxConcurrency:1,priority:40,deadlineMs:30000});
  await new Promise(resolve=>setTimeout(resolve,1500));
  const fresh=downloader.downloadRange(piece(30),resolver,{parallel:true,kind:"video",maxConcurrency:1,priority:50,deadlineMs:30000});
  await new Promise(resolve=>setTimeout(resolve,20));
  pending.shift()();
  for(let tick=0;started.length<9&&tick<100;tick+=1) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(started[8],20*64*1024,"the piece queued 1.5 s ago starts first");
  while(started.length<10||pending.length){while(pending.length)pending.shift()();await new Promise(resolve=>setTimeout(resolve,5));}
  await Promise.all([...busy,old,fresh]);
});

test("waiting media never goes before init, index or startup requests",{timeout:30000},async()=>{
  // Ordinary media gains priority while it waits; after 8 s it would outrank even 220.
  const clock={ahead:0,now(){return performance.now()+this.ahead;}};
  const {idm}=load(clock);
  const HOST="upos-sz-mirrorali.bilivideo.com",only=[mediaUrl(HOST)];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>[],rangeCandidates:()=>only,startupCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const started=[],pending=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    started.push(start);
    await new Promise(resolve=>pending.push(resolve));
    return ok(start,end,64*1024*1024);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const piece=index=>({start:index*64*1024,end:(index+1)*64*1024-1,length:64*1024});
  const busy=Array.from({length:8},(_,index)=>downloader.downloadRange(piece(index),resolver,{parallel:true,kind:"video",maxConcurrency:1,priority:50}));
  await new Promise(resolve=>setTimeout(resolve,20));
  const old=downloader.downloadRange(piece(20),resolver,{parallel:true,kind:"video",maxConcurrency:1,priority:50,deadlineMs:30000});
  await new Promise(resolve=>setTimeout(resolve,20));
  clock.ahead+=8000;
  const meta=downloader.downloadRange(piece(40),resolver,{parallel:false,kind:"meta"});
  await new Promise(resolve=>setTimeout(resolve,20));
  pending.shift()();
  for(let tick=0;started.length<9&&tick<100;tick+=1) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(started[8],40*64*1024,"the index request starts before media that waited 8 s");
  while(pending.length||started.length<10){while(pending.length)pending.shift()();await new Promise(resolve=>setTimeout(resolve,5));}
  await Promise.all([...busy,old,meta]);
});

test("an overdue piece still tries a node whose slow measurement may be stale",{timeout:30000},async()=>{
  // The copy's node was measured slow a minute ago and has recovered since. The first copy is
  // at the usual speed and misses the deadline only slightly, so the early straggler rescue
  // (which needs the first copy to be far behind) does not fire: the piece spends one of the
  // range's rescue slots on that node anyway instead of carrying on alone.
  const {idm}=load();
  const FIRST="upos-sz-mirrorali.bilivideo.com",SECOND="upos-sz-mirrorhw.bilivideo.com";
  const all=[mediaUrl(FIRST),mediaUrl(SECOND)];
  const resolver={urls:()=>all,ordered:()=>all,rescueCandidates:()=>all.slice(1),rangeCandidates:()=>all,allows:()=>true,success(){},failure(){},
    // The first node is the known-good one and carries the piece; the copy's node keeps a
    // slow measurement from a minute ago.
    speed:url=>new URL(url).hostname===SECOND?4*1024:50*1024};
  const requests=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    requests.push({host:new URL(url).hostname,at:Date.now()-began});
    // The first request of the piece trickles at about the usual speed; the recovered node answers at once.
    if(requests.length>1) return ok(start,end,64*1024*1024);
    return stepped(start,end,[[8*1024,0],...Array(31).fill([8*1024,200])],init.signal);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch});
  const alone={...resolver,urls:()=>all.slice(0,1),ordered:()=>all.slice(0,1),rescueCandidates:()=>[],rangeCandidates:()=>all.slice(0,1)};
  let began=Date.now();
  // Warm-up on the first node only: about 43 KiB/s counts as the usual connection speed.
  for(const index of [0,1]){
    requests.length=0;
    await downloader.downloadRange({start:index*64*1024,end:(index+1)*64*1024-1,length:64*1024},alone,{parallel:true,kind:"video",maxConcurrency:1});
  }
  requests.length=0;began=Date.now();
  // 64 KiB at about 40 KiB/s needs some 1.6 s; due in 1.4 s, so it is about 200 ms short.
  await downloader.downloadRange({start:10*64*1024,end:11*64*1024-1,length:64*1024},resolver,{parallel:true,kind:"video",maxConcurrency:1,deadlineMs:1400});
  assert.equal(requests.length,2,`the copy starts (${requests.map(item=>item.host+"@"+item.at).join(", ")})`);
  assert.ok(Date.now()-began<2500,`finished without waiting for a timeout: ${Date.now()-began} ms`);
});
