"use strict";
// Runs the real replay-hook.js in Node against a mock replay CDN: an origin node, one node of
// the fMP4 group that serves the same bytes, one that serves other bytes, and the rest
// refusing. hls.js's side is a minimal XMLHttpRequest that, like the browser's, can load a
// blob: address; the page's downloader side is plain fetch.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {resolveObjectURL}=require("node:buffer");
const SOURCE=path.join(__dirname,"../src");

const ORIGIN="origin.bilivideo.com";
const SAME="d1--cn-gotcha204.bilivideo.com";
const OTHER="d1--cn-gotcha208.bilivideo.com";
const PLAYLIST=`https://${ORIGIN}/live-rec/9/index.m3u8?expires=1&sign=a`;
const SEGMENTS=40;
const SEGMENT_SECONDS=3;
const segmentBytes=(n)=>{const b=new Uint8Array(32*1024);for(let i=0;i<b.length;i+=1)b[i]=(n*31+i)&255;return b;};
const playlistText=[
  "#EXTM3U","#EXT-X-VERSION:7",`#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,"#EXT-X-PLAYLIST-TYPE:VOD",
  '#EXT-X-MAP:URI="h0.m4s?sign=a"',
  ...Array.from({length:SEGMENTS},(_,n)=>[`#EXTINF:${SEGMENT_SECONDS}.000,`,`${n}.m4s?sign=a`]).flat(),
  "#EXT-X-ENDLIST",""
].join("\n");
const segUrl=(n,host=ORIGIN)=>`https://${host}/live-rec/9/${n}.m4s?sign=a`;

function setup({liveEnabled=true,broken=new Set()}={}){
  const log=[];
  // The CDN: what each node answers for a path.
  async function cdn(input,init={}){
    const url=new URL(input instanceof Request?input.url:String(input));
    const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));
    const range=headers.get("range");
    log.push({host:url.hostname,path:url.pathname,range});
    await new Promise(r=>setTimeout(r,5));
    if(init.signal?.aborted)throw init.signal.reason;
    if(url.pathname.endsWith("/stream"))return new Response(playlistText.replace("#EXT-X-ENDLIST\n","").replace("#EXT-X-PLAYLIST-TYPE:VOD\n",""),{status:200,headers:{"content-type":"text/plain"}});
    if(url.pathname.endsWith(".m3u8"))return new Response(playlistText,{status:200,headers:{"content-type":"application/vnd.apple.mpegurl"}});
    const m=/\/(h?)(\d+)\.m4s$/.exec(url.pathname);
    if(!m)return new Response("",{status:404});
    const n=Number(m[2])+(m[1]?1000:0);
    if(url.hostname===OTHER)return new Response(segmentBytes(n+7),{status:200});
    if(url.hostname!==ORIGIN&&url.hostname!==SAME)return new Response("forbidden",{status:403});
    if(broken.has(n))return new Response("boom",{status:500});
    let body=segmentBytes(n);
    if(range){const [,a,b]=/bytes=(\d+)-(\d+)/.exec(range);body=body.slice(Number(a),Number(b)+1);return new Response(body,{status:206,headers:{"content-range":`bytes ${a}-${Number(a)+body.length-1}/${segmentBytes(n).length}`}});}
    return new Response(body,{status:200,headers:{"content-length":String(body.length),"content-type":"video/iso.segment"}});
  }

  // Enough XMLHttpRequest for hls.js's XhrLoader.
  class FakeXHR{
    constructor(){this.readyState=0;this.status=0;this.response=null;this.responseText="";this.responseType="";this.listeners={};this.onreadystatechange=null;}
    addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
    removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(f=>f!==fn);}
    fire(type){if(type==="readystatechange")this.onreadystatechange?.();for(const fn of [...(this.listeners[type]||[])])fn.call(this);}
  }
  FakeXHR.prototype.open=function(method,url){this._url=String(url);this._headers={};this.readyState=1;this._sent=false;this.fire("readystatechange");};
  FakeXHR.prototype.setRequestHeader=function(n,v){this._headers[n]=v;};
  FakeXHR.prototype.abort=function(){this._aborted=true;};
  FakeXHR.prototype.send=function(){
    this._sent=true;this._aborted=false;
    const url=this._url;
    const done=(status,buffer)=>{if(this._aborted)return;this.status=status;if(this.responseType==="arraybuffer")this.response=buffer;else{this.responseText=new TextDecoder().decode(buffer);this.response=this.responseText;}this.readyState=4;this._sentTo=url;this.fire("readystatechange");this.fire("loadend");};
    if(url.startsWith("blob:")){
      log.push({host:"blob",path:url});
      resolveObjectURL(url).arrayBuffer().then(b=>done(200,b));
    }else{
      cdn(url,{headers:this._headers}).then(async r=>done(r.status,await r.arrayBuffer()));
    }
  };

  const listeners=[];
  const context=vm.createContext({
    URL,Request,Response,Headers,Blob,AbortController,DOMException,TextDecoder,console,performance,setTimeout,clearTimeout,Promise,
    location:{hostname:"live.bilibili.com",pathname:"/web-cut/quick-publish.html",href:"https://live.bilibili.com/web-cut/quick-publish.html"},
    XMLHttpRequest:FakeXHR,
    fetch:cdn
  });
  // The page's own global as its code sees it: the source of its window messages.
  const self=vm.runInContext("globalThis",context);
  const stats=[];
  context.addEventListener=(type,fn)=>{if(type==="message")listeners.push(fn);};
  context.postMessage=(data)=>{if(data?.type==="stats")stats.push(data.payload);queueMicrotask(()=>listeners.forEach(fn=>fn({source:self,data})));};
  for(const file of ["range-core.js","live-core.js","live-hook.js","replay-hook.js"]){
    vm.runInContext(fs.readFileSync(path.join(SOURCE,file),"utf8"),context,{filename:file});
  }
  context.postMessage({channel:"__BILI_RANGE_ACCELERATOR_V1__",type:"settings",payload:{enabled:true,liveEnabled}});
  return {context,log,stats,FakeXHR,
    xhr(url,responseType){return new Promise(resolve=>{const x=new context.XMLHttpRequest();x.open("GET",url,true);x.responseType=responseType;x.onreadystatechange=()=>{if(x.readyState===4)resolve(x);};x.send();});}};
}
const tick=(ms)=>new Promise(r=>setTimeout(r,ms));
const originGets=(log,n)=>log.filter(e=>e.host===ORIGIN&&e.path.endsWith(`/${n}.m4s`)&&!e.range).length;

test("off: the clip page's requests go out untouched",async()=>{
  const env=setup({liveEnabled:false});
  await tick(5);
  await env.xhr(PLAYLIST,"text");
  const x=await env.xhr(segUrl(0),"arraybuffer");
  assert.equal(x._sentTo,segUrl(0));
  await tick(50);
  assert.equal(env.log.filter(e=>e.path.endsWith(".m4s")).length,1,"no prefetch, no probes");
});

test("on: hls.js segments come from parallel prefetch, and the downloader reuses it",async()=>{
  const env=setup();
  await tick(5);
  const pl=await env.xhr(PLAYLIST,"text");
  assert.equal(pl.status,200);
  const first=await env.xhr(segUrl(0),"arraybuffer");
  assert.equal(first.status,200);
  assert.ok(first._sentTo.startsWith("blob:"),"served from memory");
  assert.equal(first.responseURL,segUrl(0),"responseURL still names the segment");
  assert.deepEqual(new Uint8Array(first.response),segmentBytes(0));
  await tick(300);
  // The window ahead (90 s = 30 segments of 3 s) is downloaded without being asked for.
  const fetchedAhead=Array.from({length:SEGMENTS},(_,n)=>n).filter(n=>env.log.some(e=>e.path.endsWith(`/${n}.m4s`)&&!e.range&&(e.host===ORIGIN||e.host===SAME)));
  assert.ok(fetchedAhead.includes(1)&&fetchedAhead.includes(30),`prefetched ${fetchedAhead.join(",")}`);
  assert.ok(!fetchedAhead.includes(35),"nothing past the window");
  // The node that serves the same bytes joined; the one with other bytes is banned.
  const hosts=env.context.__biliThreadRipperLiveDebug.getContext().hosts;
  assert.equal(hosts.find(h=>h.host===SAME).state,"healthy");
  assert.equal(hosts.find(h=>h.host===OTHER).state,"banned");
  assert.ok(!env.log.some(e=>e.host===OTHER&&!e.range),"a node with other bytes never serves a segment");
  // hls.js's next request and the downloader's fetch are answered without new downloads.
  const before=env.log.length;
  const second=await env.xhr(segUrl(1),"arraybuffer");
  assert.deepEqual(new Uint8Array(second.response),segmentBytes(1));
  const response=await env.context.fetch(segUrl(5));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),segmentBytes(5));
  assert.equal(env.log.slice(before).filter(e=>/\/(1|5)\.m4s$/.test(e.path)).length,0);
  const last=env.context.__biliThreadRipperLiveDebug.getStats();
  assert.ok(last.acceleratedRequests>=3);
  assert.equal(last.architecture,"replay-segment-ripper");
});

test("a seek restarts the window; a failing segment falls back to the page's own request",async()=>{
  const env=setup({broken:new Set([20])});
  await tick(5);
  await env.xhr(PLAYLIST,"text");
  await env.xhr(segUrl(0),"arraybuffer");
  await tick(20);
  const x=await env.xhr(segUrl(20),"arraybuffer");
  assert.equal(x.status,500,"the original request went out and its answer reached the page");
  assert.equal(x._sentTo,segUrl(20));
  await tick(300);
  assert.ok(originGets(env.log,39)+env.log.filter(e=>e.host===SAME&&e.path.endsWith("/39.m4s")).length>=1,"the window moved to the seek point");
  assert.ok(/HTTP 500/.test(env.stats.at(-1).lastError));
});

test("ranged and non-replay requests are not touched",async()=>{
  const env=setup();
  await tick(5);
  await env.xhr(PLAYLIST,"text");
  const r=await env.context.fetch(segUrl(2),{headers:{Range:"bytes=0-9"}});
  assert.equal(r.status,206);
  const before=env.log.length;
  await env.context.fetch("https://origin.bilivideo.com/elsewhere/1.m4s");
  await env.context.fetch(segUrl(3,"unknown.example.com"));
  assert.deepEqual(env.log.slice(before).map(e=>e.host),["origin.bilivideo.com","unknown.example.com"],"each went straight to the network, once");
});

test("a playlist is known by its content, whatever its address",async()=>{
  const env=setup();
  await tick(5);
  await env.xhr(`https://${ORIGIN}/live-rec/9/stream?sign=a`,"text");
  const x=await env.xhr(segUrl(0),"arraybuffer");
  assert.ok(x._sentTo.startsWith("blob:"),"served from memory");
  const events=env.context.__biliThreadRipperLiveDebug.getEvents();
  assert.ok(events.some(e=>e.what==="replay playlist"&&/no end marker/.test(e.detail)&&!/sign=/.test(e.detail)));
});

test("the downloader's playlist is known by its content over fetch too",async()=>{
  const env=setup();
  await tick(5);
  const r=await env.context.fetch(`https://${ORIGIN}/live-rec/9/stream?sign=a`);
  await r.text();
  await tick(10);
  const before=env.log.length;
  const seg=await env.context.fetch(segUrl(0));
  assert.deepEqual(new Uint8Array(await seg.arrayBuffer()),segmentBytes(0));
  await tick(200);
  assert.ok(env.log.slice(before).some(e=>/\/(10)\.m4s$/.test(e.path)),"segments ahead are prefetched for the downloader");
  assert.ok(env.context.__biliThreadRipperLiveDebug.getStats().acceleratedRequests>=1);
});
