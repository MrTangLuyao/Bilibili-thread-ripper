"use strict";
// Shared download core. BTR Desktop keeps an identical copy as test/shared.test.cjs.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=fs.existsSync(path.join(__dirname,"../shared/range-core.js"))?path.join(__dirname,"../shared"):path.join(__dirname,"../src");
function load(timing=null){
  const context=vm.createContext({URL,AbortController,DOMException,Response,ReadableStream,Headers,Uint8Array,Promise,setTimeout,clearTimeout,performance,console});
  context.globalThis=context;
  // The resolver's short failure back-off uses Date.now. Tests move this clock forward.
  context.__now=1e12;
  vm.runInContext("Date.now=()=>globalThis.__now;",context);
  for(const file of ["range-core.js","cdn-resolver.js","idm-downloader.js"]){
    vm.runInContext(fs.readFileSync(path.join(SOURCE,file),"utf8"),context,{filename:file});
    // Some tests shorten the fixed timeouts so that a first-byte timeout does not take 5.5 s.
    if(timing&&file==="range-core.js"){const core=context.__BILI_RANGE_CORE__;context.__BILI_RANGE_CORE__=Object.freeze({...core,normalizeSettings:input=>({...core.normalizeSettings(input),...timing})});}
  }
  return {core:context.__BILI_RANGE_CORE__,cdn:context.__BILI_CDN_RESOLVER_FACTORY__,idm:context.__BILI_IDM_DOWNLOADER_FACTORY__,advance:ms=>{context.__now+=ms;}};
}
const mediaUrl=host=>`https://${host}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&os=x`;
const dead=Object.assign(new Error("Range 校验失败：HTTP 503"),{name:"Error"});
const aborted=new DOMException("并发副本已取消","AbortError");

test("new defaults: mainland CDN, 8 threads, error notices off",()=>{
  const {core}=load();
  const defaults=core.normalizeSettings({});
  assert.equal(defaults.mode,"mainland");assert.equal(defaults.concurrency,8);assert.equal(defaults.errorNotices,false);assert.equal(defaults.debugNotices,false);
  const chosen=core.normalizeSettings({mode:"overseas",concurrency:32,errorNotices:true});
  assert.equal(chosen.mode,"overseas");assert.equal(chosen.concurrency,32);assert.equal(chosen.errorNotices,true);
  assert.equal(core.normalizeSettings({concurrency:7}).concurrency,8);
});

test("a node is banned after two failures that delivered 0 bytes, and only for the current video",()=>{
  const {cdn}=load();
  const banned=[];
  const bans=cdn.createBanList({onBan:host=>banned.push(host)});
  const hw=mediaUrl("upos-sz-mirrorhw.bilivideo.com");
  assert.equal(bans.record(hw,0,aborted),false,"a cancelled hedge copy is not a failure");
  assert.equal(bans.record(hw,4096,dead),false,"a transfer that sent data before stalling is not a dead node");
  assert.equal(bans.record(hw,0,dead),false);assert.equal(bans.allows(hw),true);
  // A different signed URL on the same node counts toward the same node.
  assert.equal(bans.record(hw.replace("30080","30280"),0,dead),true);
  assert.equal(bans.allows(hw),false);assert.deepEqual(Array.from(banned),["upos-sz-mirrorhw.bilivideo.com"]);
  assert.equal(bans.record(hw,0,dead),false,"a banned node is reported once");
  assert.deepEqual(Array.from(bans.hosts()),["upos-sz-mirrorhw.bilivideo.com"]);
  bans.reset();
  assert.equal(bans.allows(hw),true);assert.deepEqual(Array.from(bans.hosts()),[]);
  assert.equal(bans.record(hw,0,dead),false,"strikes start again for the next video");
});

test("resolvers skip banned nodes but never end up with no address",()=>{
  const {cdn}=load();
  const bans=cdn.createBanList();
  const resolver=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")},()=> "mainland",bans);
  const hostsOf=list=>Array.from(list,url=>new URL(url).hostname);
  assert.equal(resolver.urls().length,8);
  resolver.failure(mediaUrl("upos-sz-mirrorhw.bilivideo.com"),dead,0);
  assert.equal(resolver.urls().length,8,"one strike does not ban");
  resolver.failure(mediaUrl("upos-sz-mirrorhw.bilivideo.com"),dead,0);
  for(const list of [resolver.urls(),resolver.ordered(0),resolver.rangeCandidates(),resolver.rescueCandidates(),resolver.startupCandidates()]){
    assert.ok(!hostsOf(list).includes("upos-sz-mirrorhw.bilivideo.com"));assert.ok(list.length>0);
  }
  assert.equal(resolver.allows(mediaUrl("upos-sz-mirrorhw.bilivideo.com")),false);
  assert.equal(Array.from(resolver.status()).find(item=>item.host==="upos-sz-mirrorhw.bilivideo.com").state,"banned");
  // Another resolver of the same video (audio track, other quality) shares the list.
  const audio=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorbos.bilivideo.com")},()=> "mainland",bans);
  assert.ok(!hostsOf(audio.urls()).includes("upos-sz-mirrorhw.bilivideo.com"));
  for(const host of cdn.MAINLAND_HOSTS){bans.record(mediaUrl(host),0,dead);bans.record(mediaUrl(host),0,dead);}
  assert.equal(resolver.urls().length,8,"with every node banned the original list is used again");
  assert.ok(resolver.startupCandidates().length>0);
  // Without a ban list the resolver keeps its old behaviour.
  const plain=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")},()=> "mainland");
  plain.failure(mediaUrl("upos-sz-mirrorhw.bilivideo.com"),dead,0);plain.failure(mediaUrl("upos-sz-mirrorhw.bilivideo.com"),dead,0);
  assert.equal(plain.allows(mediaUrl("upos-sz-mirrorhw.bilivideo.com")),true);
});

test("the downloader reports received bytes, bans a silent node and stops using it",{timeout:60000},async()=>{
  const {cdn,idm,advance}=load();
  const DEAD="upos-sz-mirrorhw.bilivideo.com",PARTIAL="upos-sz-mirrorbos.bilivideo.com";
  const requests=new Map(),banned=[];
  const count=host=>requests.get(host)||0;
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;requests.set(host,count(host)+1);
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
    const headers={"Content-Range":`bytes ${start}-${end}/8388608`};
    if(host===DEAD)return new Response("",{status:503});
    if(host===PARTIAL){
      // Sends a little data, then the connection breaks: slow, not dead.
      let sent=false;
      const body=new ReadableStream({pull(controller){if(sent)controller.error(new Error("连接中断"));else{sent=true;controller.enqueue(new Uint8Array(1024));}}});
      return new Response(body,{status:206,headers});
    }
    const bytes=new Uint8Array(end-start+1);for(let i=0;i<bytes.length;i++)bytes[i]=(start+i)%251;
    return new Response(bytes,{status:206,headers});
  };
  const transfers=[];
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8}),nativeFetch,onTransfer:event=>{transfers.push(event);return transfers.length;}});
  const bans=cdn.createBanList({onBan:host=>banned.push(host)});
  const resolver=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")},()=> "mainland",bans);
  const range={start:0,end:1024*1024-1,length:1024*1024};
  const download=async()=>{const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});assert.equal(result.bytes.length,range.length);assert.ok(result.bytes.every((value,i)=>value===i%251));};
  // Each round starts after the short back-off, as when a user keeps watching.
  for(let round=0;round<6&&!banned.length;round++){await download();advance(61000);}
  assert.deepEqual(Array.from(banned),[DEAD]);
  // Parallel pieces may already be waiting on the node when the second empty reply arrives.
  assert.ok(count(DEAD)>=2,"banned only after two empty replies");
  assert.ok(count(PARTIAL)>=2,"the partial node was tried");
  assert.equal(bans.allows(mediaUrl(PARTIAL)),true,"a node that sent data is not banned");
  const before=count(DEAD);
  for(let round=0;round<3;round++){await download();advance(61000);}
  assert.equal(count(DEAD),before,"a banned node gets no new requests in this video");
  assert.ok(transfers.some(event=>event.phase==="error"));
  bans.reset();
  assert.equal(resolver.allows(mediaUrl(DEAD)),true);
});

const AKAMAI="upos-hz-mirrorakam.akamaized.net";
const akamaiUrl=os=>`https://${AKAMAI}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&os=${os}`;
const refused=Object.assign(new Error("Range 校验失败：HTTP 403"),{status:403});

test("akamaized.net addresses are host-swapped only when Bilibili hands out nothing else",()=>{
  const {cdn}=load();
  const hostsOf=list=>Array.from(new Set(Array.from(list,url=>new URL(url).hostname)));
  const akamaiOnly={baseUrl:akamaiUrl("cosovbv"),backupUrl:[akamaiUrl("akam")]};
  const mainland=cdn.representationUrls(akamaiOnly,"mainland");
  assert.equal(mainland.length,16,"two addresses on each of the eight mainland nodes");
  assert.deepEqual(hostsOf(mainland),Array.from(cdn.MAINLAND_HOSTS));
  // Node-major order: the first requests already cover both addresses.
  assert.deepEqual(Array.from(mainland.slice(0,2),url=>new URL(url).searchParams.get("os")),["cosovbv","akam"]);
  const overseas=cdn.representationUrls(akamaiOnly,"overseas");
  assert.deepEqual(Array.from(overseas.slice(0,2)),[akamaiUrl("cosovbv"),akamaiUrl("akam")],"the originals stay first in overseas mode");
  assert.deepEqual(hostsOf(overseas),[AKAMAI,...cdn.OVERSEAS_HOSTS]);
  // With an ordinary address present nothing changes: it is the only donor.
  const mixed={baseUrl:akamaiUrl("akam"),backupUrl:[mediaUrl("upos-sz-mirrorcosov.bilivideo.com")]};
  const mixedMainland=cdn.representationUrls(mixed,"mainland");
  assert.equal(mixedMainland.length,8);
  assert.ok(mixedMainland.every(url=>new URL(url).searchParams.get("os")==="x"));
  assert.equal(cdn.swapOrdinaryHost(akamaiUrl("akam"),"upos-sz-mirrorali.bilivideo.com"),null);
  // A peer CDN's port must not follow the address to another node.
  assert.equal(new URL(cdn.swapOrdinaryHost("https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/a/b.m4s?e=1","upos-sz-mirrorali.bilivideo.com")).port,"");
});

test("a refused address is dropped instead of the nodes it was tried on",()=>{
  const {cdn}=load();
  const banned=[];
  const bans=cdn.createBanList({onBan:(host,_count,_error,kind)=>banned.push(kind)});
  const at=(host,os)=>akamaiUrl(os).replace(AKAMAI,host);
  // Refused before anything has delivered: nobody is blamed yet.
  bans.record(akamaiUrl("cosovbv"),0,refused);bans.record(akamaiUrl("cosovbv"),0,refused);
  assert.equal(bans.allows(akamaiUrl("cosovbv")),true);assert.deepEqual(banned,[]);
  // The same node serves the other address, so the refused address is at fault.
  bans.success(akamaiUrl("akam"));
  assert.equal(bans.allowsAddress(akamaiUrl("cosovbv")),false);
  assert.equal(bans.allows(at("upos-sz-mirrorali.bilivideo.com","cosovbv")),false,"the address is dropped on every node");
  assert.equal(bans.allows(akamaiUrl("akam")),true);assert.deepEqual(Array.from(bans.hosts()),[]);assert.deepEqual(banned,["address"]);
  // A node that refuses an address other nodes serve is at fault itself.
  const lacking="upos-sz-mirrorbos.bilivideo.com";
  bans.record(at(lacking,"akam"),0,refused);assert.equal(bans.allows(at(lacking,"akam")),true);
  bans.record(at(lacking,"akam"),0,refused);
  assert.equal(bans.allowsNode(at(lacking,"akam")),false);assert.equal(bans.allowsAddress(at(lacking,"akam")),true);
  assert.deepEqual(Array.from(bans.hosts()),[lacking]);assert.deepEqual(banned,["address","node"]);
  bans.reset();
  assert.equal(bans.allows(akamaiUrl("cosovbv")),true);assert.equal(bans.allows(at(lacking,"akam")),true);
});

test("a node that delivers one address keeps being used after refusing another that other nodes serve",()=>{
  const {cdn}=load();
  const banned=[];
  const bans=cdn.createBanList({onBan:(host,_count,_error,kind)=>banned.push(kind)});
  const mirror="upos-sz-mirroraliov.bilivideo.com";
  const at=(host,os)=>akamaiUrl(os).replace(AKAMAI,host);
  // The mirror serves both addresses, akamaized.net only one of them.
  bans.success(at(mirror,"cosovbv"));bans.success(at(mirror,"akam"));bans.success(akamaiUrl("akam"));
  bans.record(akamaiUrl("cosovbv"),0,refused);bans.record(akamaiUrl("cosovbv"),0,refused);
  assert.equal(bans.allows(akamaiUrl("cosovbv")),false,"that address is not asked of that node again");
  assert.equal(bans.allows(akamaiUrl("akam")),true,"the node keeps its working address");
  assert.equal(bans.allows(at(mirror,"cosovbv")),true,"the address stays in use where it works");
  assert.deepEqual(Array.from(bans.hosts()),[]);assert.deepEqual(banned,["address"]);
  const resolver=cdn.createResolver({baseUrl:akamaiUrl("cosovbv"),backupUrl:[akamaiUrl("akam")]},()=> "overseas",bans);
  assert.ok(Array.from(resolver.urls()).includes(akamaiUrl("akam")));assert.ok(!Array.from(resolver.urls()).includes(akamaiUrl("cosovbv")));
  assert.ok(Array.from(resolver.status()).every(item=>item.state!=="banned"));
  // On a node with two addresses, the one that has delivered is chosen first.
  assert.equal(resolver.pick([at("upos-sz-mirrorcosov.bilivideo.com","cosovbv").replace("os=cosovbv","os=other"),at("upos-sz-mirrorcosov.bilivideo.com","akam")],new Set(),65536),at("upos-sz-mirrorcosov.bilivideo.com","akam"));
});

test("pieces grow with the speed of the fastest node, so a far but fast node is not judged by its round trip",()=>{
  const {cdn}=load();
  const nodeStats=cdn.createNodeStats();
  const resolver=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorcosov.bilivideo.com")},()=> "overseas",null,nodeStats);
  assert.equal(resolver.pieceBytes(65536),65536,"nothing measured yet: the old 64 KiB");
  const far=mediaUrl("upos-sz-mirrorcosov.bilivideo.com"),near=mediaUrl("upos-sz-mirroraliov.bilivideo.com");
  nodeStats.begin(far);nodeStats.firstByte(far,370);nodeStats.body(far,1024*1024,300);nodeStats.end(far,true);
  nodeStats.begin(near);nodeStats.firstByte(near,40);nodeStats.body(near,65536,160);nodeStats.end(near,true);
  const size=resolver.pieceBytes(65536);
  assert.ok(size>=400*1024&&size<=512*1024,`piece size ${size}`);
  assert.equal(resolver.pick([near,far],new Set(),size),far,"a piece of that size finishes first on the fast node despite its round trip");
  assert.equal(resolver.pick([near,far],new Set(),65536),near,"for 64 KiB the round trip decided");
});

test("an akamaized.net-only video downloads in mainland mode and stops asking for the refused address",{timeout:60000},async()=>{
  const {cdn,idm}=load();
  const asked={cosovbv:0,akam:0};
  const nativeFetch=async(url,init)=>{
    const os=new URL(url).searchParams.get("os");asked[os]+=1;
    if(os==="cosovbv")return new Response("",{status:403});
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
    return new Response(new Uint8Array(end-start+1),{status:206,headers:{"Content-Range":`bytes ${start}-${end}/8388608`}});
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:8,mode:"mainland"}),nativeFetch});
  const bans=cdn.createBanList();
  const resolver=cdn.createResolver({baseUrl:akamaiUrl("cosovbv"),backupUrl:[akamaiUrl("akam")]},()=> "mainland",bans);
  const meta=await downloader.downloadRange({start:0,end:999,length:1000},resolver,{parallel:false,kind:"meta"});
  assert.equal(meta.bytes.length,1000);
  const range={start:1000,end:1000+1024*1024-1,length:1024*1024};
  assert.equal((await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"})).bytes.length,range.length);
  // The address that has delivered is asked first on every node, so the refused one may not
  // even collect the two refusals that drop it. Either way it is given up on at once.
  assert.ok(asked.cosovbv<=4,`the refused address was asked ${asked.cosovbv} times`);assert.deepEqual(Array.from(bans.hosts()),[],"no node is banned for the refused address");
  const before=asked.cosovbv;
  await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});
  assert.equal(asked.cosovbv,before,"the refused address gets no new requests");
  assert.ok(Array.from(resolver.status()).every(item=>item.state!=="banned"));
});

test("a piece with a single address survives failed replies instead of ending the video",{timeout:60000},async()=>{
  const {idm}=load();
  const only=mediaUrl("upos-sz-mirrorali.bilivideo.com");
  let requests=0;
  const nativeFetch=async(_url,init)=>{
    requests+=1;
    if(requests<=2)return new Response("",{status:503});
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
    return new Response(new Uint8Array(end-start+1),{status:206,headers:{"Content-Range":`bytes ${start}-${end}/8388608`}});
  };
  const resolver={urls:()=>[only],ordered:()=>[only],rescueCandidates:()=>[only],rangeCandidates:()=>[only],allows:()=>true,success(){},failure(){}};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  const range={start:0,end:32767,length:32768};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});
  assert.equal(result.bytes.length,range.length);assert.equal(requests,3);
});

// The scheduler tests run against dev/network-sim.js, a stand-in CDN with made-up node speeds.
const {createNetwork,watchVideo}=require("./network-sim.js");
const MB=1024*1024;
const overseasNodes=()=>({
  [AKAMAI]:{ttfbMs:450,connBps:0.9*MB,totalBps:6*MB,sockets:6},
  "upos-sz-mirrorcosov.bilivideo.com":{ttfbMs:120,connBps:1.6*MB,totalBps:9*MB},
  "upos-sz-mirroraliov.bilivideo.com":{ttfbMs:260,connBps:1.1*MB,totalBps:6*MB},
  "cn-hk-eq-01-01.bilivideo.com":{ttfbMs:1100,connBps:0.35*MB,totalBps:2*MB},
  "cn-hk-eq-01-03.bilivideo.com":{ttfbMs:700,connBps:0.5*MB,totalBps:3*MB}
});
const shareOf=(network,host)=>(network.stats.byHost[host]?.bytes||0)/network.stats.sentBytes;

test("fast nodes carry most of a video and almost nothing is downloaded twice",{timeout:120000},async()=>{
  const lib=load();
  const network=createNetwork({nodes:overseasNodes(),linkBps:12.5*MB});
  try{
    const nodeStats=lib.cdn.createNodeStats();
    const first=await watchVideo(lib,network,{representation:{baseUrl:akamaiUrl("akam")},nodeStats,segments:6});
    assert.deepEqual(Array.from(first.bans.hosts()),[]);
    assert.ok(network.stats.canceledBytes<network.stats.sentBytes*0.05,`second copies took ${network.stats.canceledBytes} of ${network.stats.sentBytes} bytes`);
    assert.ok(shareOf(network,"upos-sz-mirrorcosov.bilivideo.com")>shareOf(network,"upos-sz-mirroraliov.bilivideo.com"),"the fastest node carries the most");
    assert.ok(shareOf(network,"cn-hk-eq-01-01.bilivideo.com")<0.1,"the slowest node carries little");
    assert.ok(first.downloader.duplicateBytes<=network.stats.canceledBytes);
    // After a seek the player starts again with new resolvers. What is known about the nodes
    // is kept, so nothing is raced again and the restart is no slower than the cold start.
    const racedBefore=network.stats.byHost["cn-hk-eq-01-01.bilivideo.com"].requests,answeredBefore=network.stats.lengths.length;
    assert.ok(network.stats.lengths.includes(65536),"the cold start sends the 64 KiB head on its own");
    const second=await watchVideo(lib,network,{representation:{baseUrl:akamaiUrl("akam")},nodeStats,segments:2});
    assert.ok(second.startupMs<=first.startupMs*1.25,`restart ${Math.round(second.startupMs)} ms, cold start ${Math.round(first.startupMs)} ms`);
    assert.ok(network.stats.byHost["cn-hk-eq-01-01.bilivideo.com"].requests-racedBefore<=2,"the slowest node is not raced again");
    assert.ok(!network.stats.lengths.slice(answeredBefore).includes(65536),"with the nodes known, the restart does not wait for a head piece first");
  }finally{network.stop();}
});

test("a node that turns slow in the middle of a video is left, and the video goes on",{timeout:120000},async()=>{
  const lib=load();
  const nodes=overseasNodes();
  const network=createNetwork({nodes,linkBps:12.5*MB});
  try{
    const nodeStats=lib.cdn.createNodeStats(),bans=lib.cdn.createBanList();
    await watchVideo(lib,network,{representation:{baseUrl:akamaiUrl("akam")},nodeStats,bans,segments:3});
    const fast="upos-sz-mirrorcosov.bilivideo.com";
    nodes[fast].connBps=8*1024;nodes[fast].totalBps=64*1024;
    const before=network.stats.byHost[fast].bytes,sentBefore=network.stats.sentBytes;
    const later=await watchVideo(lib,network,{representation:{baseUrl:akamaiUrl("akam")},nodeStats,bans,segments:5});
    const share=(network.stats.byHost[fast].bytes-before)/(network.stats.sentBytes-sentBefore);
    assert.ok(share<0.15,`the slow node still carried ${Math.round(share*100)}%`);
    assert.ok(later.totalMs<20000,`took ${Math.round(later.totalMs)} ms`);
  }finally{network.stop();}
});

test("a request left waiting in the browser does not count against a node that is sending",{timeout:120000},async()=>{
  // Two sockets stand for the six a browser opens to an HTTP/1.1 node; the first-byte timeout
  // is shortened to match. Requests beyond the sockets time out without ever being sent.
  const lib=load({firstByteTimeoutMs:500});
  const queueing="upos-sz-mirrorcosov.bilivideo.com",other="upos-sz-mirroraliov.bilivideo.com";
  const network=createNetwork({nodes:{[queueing]:{ttfbMs:50,connBps:0.2*MB,sockets:2},[other]:{ttfbMs:80,connBps:0.2*MB}}});
  try{
    const banned=[],timeouts=[];
    const bans=lib.cdn.createBanList({onBan:host=>banned.push(host)});
    const resolver=lib.cdn.createResolver({baseUrl:mediaUrl(queueing)},()=> "overseas",bans);
    const downloader=lib.idm.createDownloader({getSettings:()=>({concurrency:8,mode:"overseas"}),nativeFetch:network.fetch,onTransfer:event=>{if(event.phase==="error"&&/首字节/.test(event.error?.message))timeouts.push(event);return 1;}});
    const range={start:0,end:2*MB-1,length:2*MB};
    for(let round=0;round<3;round++)assert.equal((await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"})).bytes.length,range.length);
    assert.ok(timeouts.length>0,"some requests did wait past the first-byte timeout");
    assert.ok(!banned.includes(queueing),"the node that was sending the whole time is not banned");
    assert.ok(network.stats.byHost[queueing].bytes>0.2*network.stats.sentBytes,"and it keeps being used");
    const before=timeouts.length;
    await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});
    assert.equal(timeouts.length,before,"once its limit is known it is not given more than it can carry");
  }finally{network.stop();}
});

test("a node that is merely slower than the old fixed delay is not downloaded twice",{timeout:60000},async()=>{
  const lib=load();
  const slow="upos-sz-mirrorcosov.bilivideo.com";
  const network=createNetwork({nodes:{[slow]:{ttfbMs:1200,connBps:4*MB}}});
  try{
    const resolver=lib.cdn.createResolver({baseUrl:mediaUrl(slow)},()=> "overseas");
    const downloader=lib.idm.createDownloader({getSettings:()=>({concurrency:8,mode:"overseas"}),nativeFetch:network.fetch});
    const range={start:0,end:MB-1,length:MB};
    await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});
    const learned=downloader.stats().copies;
    await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});
    assert.equal(downloader.stats().copies,learned,"once the node's usual first-byte time is known, waiting that long is not a reason for a copy");
  }finally{network.stop();}
});
