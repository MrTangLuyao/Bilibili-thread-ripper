"use strict";
// The diagnostic copy's formatter (src/diagnostic-report.js): the layout of format 1 on a
// snapshot shaped like issue #65's report, the line grammar, what never reaches the text, the
// English for every Chinese message BTR throws, and that it never throws itself.
// BTR_DIAG_SAMPLE=<file> also writes the fixture's report there, to read it whole.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=path.join(__dirname,"../src");
function load(){
  const context=vm.createContext({});
  context.globalThis=context;
  vm.runInContext(fs.readFileSync(path.join(SOURCE,"diagnostic-report.js"),"utf8"),context,{filename:"diagnostic-report.js"});
  return context.__BTR_DIAGNOSTIC_REPORT__;
}
const report=load();

// issue #65 (2026.11.3.1, Edge, Hong Kong): copied 18.042 s after the page loaded, the video
// paused at 0.000 s after Bilibili replaced the source and BTR took over again. The numbers are
// the issue's; what that build did not record yet is filled in the way a new build records it.
const CAPTURED=Date.parse("2026-11-04T07:10:38.382Z"),NOW=18042,ORIGIN=CAPTURED-NOW;
const host=(name)=>`upos-sz-${name}.bilivideo.com`;
function fixture(){
  return {
    capturedAt:CAPTURED,timeOrigin:ORIGIN,now:NOW,
    btr:{version:"2026.11.3.1",channel:"stable",otherBuild:"",scriptManager:"Tampermonkey 5.5.1",host:"userscript"},
    env:{userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0",language:"zh-TW",viewport:"1680x876",page:"https://www.bilibili.com/video/BV1UjxD69EKs/"},
    settings:{enabled:true,theme:"auto",liveEnabled:false,episodeEnabled:true,blockInternational:false,takeover:"full",mode:"mainland",customHosts:[],floatingButton:true,floatingButtonLeft:0,floatingButtonTop:0.8979357798165137,guideDone:true,concurrency:8,autoConcurrency:true,minChunkBytes:65536,firstByteTimeoutMs:5500,stallTimeoutMs:4000,attemptTimeoutMs:15000,hedgeDelayMs:900,bufferAheadSeconds:45,secondaryBuffer:false},
    site:{international:false,signedIn:false,userSite:"",accountSites:null,lang:"",guard:"on",redirectsBlocked:0,gaveUp:false},
    video:{
      version:"2026.11.3.1",channel:"stable",scriptManager:"Tampermonkey 5.5.1",at:NOW,timeOrigin:ORIGIN,route:"bv1ujxd69eks:p1",
      settings:{takeover:"full",mode:"mainland",customHosts:[],concurrency:8,codec:"default"},
      actualTakeover:"full",
      nativeQuality:{nowQ:80,newQ:0,realQ:80},
      nativeCore:{buffersLocked:2,mediaRequests:2},
      playback:{currentTime:0,duration:152,ended:false,paused:true,elementPaused:true,seeking:false,readyState:4,networkState:1,playbackRate:1.2,width:1080,height:1920,visibility:"visible",
        frames:{total:4,dropped:0},
        lastPresentedFrame:{mediaTime:0,mediaClock:0,observedAtMs:2749.0999999996275,expectedDisplayTimeMs:2722.3,presentedFrames:1,ageMs:15293.300000000745},
        mediaError:null,buffered:[[0,5.1]]},
      state:"ready",lastError:"",
      player:{version:"2026.11.3.1",architecture:"bilibili-native-ui-progressive-mse-0.8-core",quality:"1080P",qualityId:80,preferredQuality:80,autoQuality:80,preferredCodec:"",preferredAudio:0,codecFailuresBlocked:0,sessionStarts:1,codec:"avc",width:1080,height:1920,frameRate:30,
        videoType:"video/mp4; codecs=\"avc1.640033\"",audioType:"audio/mp4; codecs=\"mp4a.40.2\"",videoBandwidth:1175160,audioBandwidth:175791,currentTime:0,mediaSourceState:"open",playbackActivated:true,resumeWanted:false,sessionStartTime:0,startupBufferSeconds:2.5,startupWaitingEvents:0,bufferAheadLimit:0,
        reserve:{seconds:0,bytes:0,limitBytes:536870912},uiBufferLimit:0,urlDeadline:1793783421,nativeLeftoversSuppressed:0,lastNativeLeftover:"",progressiveAppends:12,underflowRebuffers:0,seekReloads:0,nativeRestoresUndone:0,lastSeekMs:0,stallsAfterSeek:0,
        qualities:[80,64,32,16],elementPaused:true,
        tracks:[{kind:"video",nextIndex:10,segments:31},{kind:"audio",nextIndex:9,segments:31}]},
      nodes:[
        {host:host("mirrorali"),state:"untested",bps:0},{host:host("mirrorhw"),state:"healthy",bps:2127099.385981325},
        {host:host("mirrorbos"),state:"untested",bps:0},{host:host("mirror08c"),state:"banned",bps:0},
        {host:host("mirrorbd"),state:"untested",bps:0},{host:host("mirror14b"),state:"healthy",bps:626133.8574954458},
        {host:host("estgoss"),state:"healthy",bps:228326.35595131625},{host:host("mirrorcos"),state:"untested",bps:0},
        {host:host("mirrorcoso1"),state:"healthy",bps:140512.39275512952}],
      bannedNodes:[host("mirror08c")],
      bans:[{at:2433,kind:"node",host:host("mirror08c"),count:2,error:"Failed to fetch"}],
      downloads:{
        byKind:{video:{started:84,ok:64,failed:1,cancelled:19,bytes:6511000},audio:{started:27,ok:18,failed:1,cancelled:8,bytes:1153000},meta:{started:9,ok:8,failed:0,cancelled:1,bytes:12300}},
        cancelReasons:{"并发副本已取消":28},
        hosts:{
          [host("mirror08c")]:{ok:0,failed:2,cancelled:0,bytes:0,lastError:"Failed to fetch",lastErrorAt:2433},
          [host("mirrorhw")]:{ok:62,failed:0,cancelled:1,bytes:5600000,lastError:"",lastErrorAt:0},
          [host("mirror14b")]:{ok:13,failed:0,cancelled:6,bytes:1350000,lastError:"",lastErrorAt:0},
          [host("estgoss")]:{ok:4,failed:0,cancelled:3,bytes:400000,lastError:"",lastErrorAt:0},
          [host("mirrorcoso1")]:{ok:3,failed:0,cancelled:0,bytes:314000,lastError:"",lastErrorAt:0},
          [host("mirrorali")]:{ok:0,failed:0,cancelled:10,bytes:0,lastError:"",lastErrorAt:0},
          [host("mirrorcos")]:{ok:0,failed:0,cancelled:7,bytes:0,lastError:"",lastErrorAt:0},
          [host("mirrorcosov")]:{ok:8,failed:0,cancelled:0,bytes:12300,lastError:"",lastErrorAt:0},
          "upos-hz-mirrorakam.akamaized.net":{ok:0,failed:0,cancelled:1,bytes:0,lastError:"",lastErrorAt:0}},
        active:0,lastBytesAt:4803},
      page:[
        {at:412,time:0,what:"settings applied",detail:"full, mainland, threads auto",level:"info"},
        {at:1021,time:0,what:"threads changed",detail:"8 -> 16 (开头先用 16 线程)",level:"info"},
        {at:1024,time:0,what:"took over",detail:"bv1ujxd69eks:p1",level:"info"},
        {at:1024,time:0,what:"native buffer locked",detail:"video",level:"debug"},
        {at:1024,time:0,what:"native buffer locked",detail:"audio",level:"debug"},
        {at:1024,time:0,what:"native scheduler stopped",detail:"video",level:"debug"},
        {at:1024,time:0,what:"native scheduler stopped",detail:"audio",level:"debug"},
        {at:1650,time:0,what:"Bilibili replaced the video source",detail:"viewer at 0.0, paused",level:"info"},
        {at:1650,time:0,what:"player stopped",detail:"loading",level:"info"},
        {at:1877,time:0,what:"took over",detail:"bv1ujxd69eks:p1",level:"info"},
        {at:1877,time:0,what:"native buffer locked",detail:"video",level:"debug"},
        {at:1877,time:0,what:"native buffer locked",detail:"audio",level:"debug"},
        {at:1877,time:0,what:"native scheduler stopped",detail:"video",level:"debug"},
        {at:1877,time:0,what:"native scheduler stopped",detail:"audio",level:"debug"},
        {at:2402,time:0,what:"range failed",detail:`video ${host("mirror08c")} after 0 KiB: Failed to fetch`,level:"warn"},
        {at:2433,time:0,what:"node banned",detail:`${host("mirror08c")}, 2 failures with no data`,level:"warn"},
        {at:2433,time:0,what:"range failed",detail:`audio ${host("mirror08c")} after 0 KiB: Failed to fetch`,level:"warn"}],
      timeline:[
        {at:1874,time:0,what:"session",detail:"qn 80 avc from 0.0"},
        {at:1906,time:0,what:"headers requested",detail:"video"},
        {at:1907,time:0,what:"headers requested",detail:"audio"},
        {at:2706,time:0,what:"first segment in",detail:"audio 111 KiB in 2 pieces"},
        {at:2721,time:0,what:"first segment in",detail:"video 948 KiB in 10 pieces"},
        {at:2721,time:0,what:"ready to play",detail:"needed 2.5 s buffered"}],
      previousPlayer:{route:"bv1ujxd69eks:p1",timeline:[
        {at:1019,time:0,what:"session",detail:"qn 80 avc from 0.0"},
        {at:1030,time:0,what:"headers requested",detail:"video"},
        {at:1031,time:0,what:"headers requested",detail:"audio"}]}
    },
    stats:{playerState:"ready",bufferedAhead:5,autoThreads:16,totalSpeedBps:0,lastError:"",takeoverError:null},
    autoThreads:{threads:16,level:2,reason:"开头先用 16 线程",steps:1,changedAt:1021.1999999992549,throughputBps:0,saturation:0,buckets:0,activityAgeMs:13239,resting:[],trial:null,startup:{base:8,forMs:13832}},
    media:[
      {at:1031,name:"emptied",time:0,detail:""},
      {at:1648,name:"pause",time:0,detail:""},
      {at:1881,name:"emptied",time:0,detail:""},
      {at:1882,name:"ratechange",time:0,detail:"1.2x"},
      {at:2215,name:"loadedmetadata",time:0,detail:""},
      {at:2726,name:"canplay",time:0,detail:""}],
    live:[],
    readErrors:[]
  };
}

// The rules every report keeps, whatever it was made from.
function grammar(text,label="report"){
  const lines=text.split("\n");
  assert.match(lines[0],/^BTR diagnostics \(format 1\) \| /,`${label}: the first line names the format`);
  lines.forEach((line,index)=>{
    assert.match(line,/^[\x20-\x7e]*$/,`${label} line ${index+1} is printable ASCII without tabs: ${JSON.stringify(line)}`);
    assert.equal(line,line.trimEnd(),`${label} line ${index+1} has no trailing space`);
    assert.ok(line.length<=200,`${label} line ${index+1} has at most 200 chars (${line.length})`);
  });
  const end=/^== End ==  (\d+) lines, (\d+) chars$/.exec(lines.at(-1));
  assert.ok(end,`${label}: the last line is the End line`);
  assert.equal(Number(end[1]),lines.length,`${label}: the End line counts the lines`);
  assert.equal(Number(end[2]),text.length,`${label}: the End line counts the chars`);
  assert.equal(lines.at(-2),"",`${label}: a blank line comes before the End line`);
  assert.ok(text.length<48000,`${label} stays under 48000 chars`);
  return lines;
}
// The lines of one section, without its heading.
function section(text,title){
  const lines=text.split("\n");
  const start=lines.findIndex(line=>line===`== ${title} ==`||line.startsWith(`== ${title} ==  `));
  assert.ok(start>=0,`section ${title} is there`);
  const end=lines.findIndex((line,index)=>index>start&&line==="");
  return lines.slice(start+1,end);
}
const headings=(text)=>text.split("\n").filter(line=>line.startsWith("== ")).map(line=>/^== (.+?) ==/.exec(line)[1]);
const eventLines=(text)=>section(text,"Events").slice(1);

test("the issue #65 fixture renders the format 1 layout",()=>{
  const text=report.render(fixture());
  if(process.env.BTR_DIAG_SAMPLE) fs.writeFileSync(process.env.BTR_DIAG_SAMPLE,text);
  const lines=grammar(text);
  assert.equal(report.FORMAT,"1");
  assert.equal(lines[0],"BTR diagnostics (format 1) | BTR 2026.11.3.1 stable | captured 2026-11-04T07:10:38.382Z");
  assert.equal(lines[1],"Clock: T = seconds since page load at 2026-11-04T07:10:20.340Z; captured at T+18.042");
  assert.equal(lines[2],"");
  assert.deepEqual(headings(text),["Summary","Checks","Environment","Site","Settings","Playback","Downloads","CDN nodes","Events","End"]);
  assert.deepEqual(section(text,"Summary"),[
    "state         ready",
    "engine        full (setting full)",
    "position      0.000 / 152.000 s",
    "paused        page yes, element yes",
    "picture       last frame at T+2.749 (media 0.000 s), 4 total, 0 dropped",
    "quality       playing qn 80 (1080P), menu auto (shows qn 80)",
    "video         avc1.640033 1080x1920 30 fps 1.18 Mbit/s",
    "audio         mp4a.40.2 0.18 Mbit/s",
    "buffer ahead  5.1 s",
    "threads       16 (auto)",
    "requests      120: 90 ok, 2 failed, 28 cancelled",
    "nodes         4 healthy, 4 untested, 1 banned, 2 unlisted",
    "last error    none"
  ]);
  assert.deepEqual(section(text,"Checks"),[
    "WARN  node-banned          upos-sz-mirror08c.bilivideo.com: 2 failures with no data (Failed to fetch)",
    "WARN  range-failures       2 failed requests on 1 node",
    "INFO  source-replaced      Bilibili replaced the video source 1 time (last at T+1.650)"
  ]);
  const environment=section(text,"Environment");
  assert.deepEqual(environment,[
    "btr          2026.11.3.1 stable (userscript)",
    "other build  none",
    "manager      Tampermonkey 5.5.1",
    "browser      Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0",
    "language     zh-TW",
    "viewport     1680x876",
    "page         https://www.bilibili.com/video/BV1UjxD69EKs/",
    "route        bv1ujxd69eks:p1",
    "read errors  none"
  ]);
  assert.deepEqual(section(text,"Site"),[
    "site         domestic","signed in    no","user_site    none","account      n/a","lang cookie  none","guard        on","blocked      0 redirects","gave up      no"
  ]);
  assert.equal(lines.find(line=>line.startsWith("== Settings ==")),"== Settings ==  (* = changed from default)");
  assert.deepEqual(section(text,"Settings"),[
    "enabled              yes","takeover             full","cdn                  mainland","custom hosts         none","threads              auto",
    "buffer ahead         45 s","secondary buffer     no","audio acceleration   n/a","auto quality limit   n/a","episodes             yes","live                 no","block international  no"
  ]);
  // Every row, in order: a row that goes missing or moves fails here.
  assert.deepEqual(section(text,"Playback"),[
    "session         started at 0.000 s (T+1.874)","media source    open","activated       yes","play wanted     no",
    "ready state     4 HAVE_ENOUGH_DATA","network state   1 IDLE","buffered        0.0-5.1","startup buffer  2.5 s",
    "rebuffers       0","seek reloads    0","last seek       none",
    "quality pick    preferred qn 80 (1080P), auto qn 80 (1080P), menu now 80 new 0 real 80","qualities       80, 64, 32, 16",
    "codec pick      default","segments        video 10/31, audio 9/31","urls expire     2026-11-04T09:10:21Z (in 119.7 min)",
    "native core     2 buffers locked, 2 media requests, 0 hidden console errors, 0 codec-failure writes blocked","second buffer   off"
  ]);
  assert.deepEqual(section(text,"Downloads"),[
    "video         84 started, 64 ok, 1 failed, 19 cancelled, 6.21 MiB","audio         27 started, 18 ok, 1 failed, 8 cancelled, 1.10 MiB",
    "meta          9 started, 8 ok, 0 failed, 1 cancelled, 12 KiB","active        0","cancelled     28 hedge-lost","throughput    0.00 Mbit/s",
    "last data     T+4.803","auto threads  16, level 2, 1 step, last change T+1.021 (start with 16 threads)","trial         none","resting       none",
    "startup       back to 8 threads by T+31.874"
  ]);
  const nodes=section(text,"CDN nodes");
  assert.match(nodes[0],/^HOST +STATE +Mbit\/s +OK +FAIL +CXL +DATA +LAST ERROR$/);
  assert.match(nodes[1],/^upos-sz-mirror08c\.bilivideo\.com +banned +- +0 +2 +0 +0 B +Failed to fetch$/,"the banned node comes first");
  assert.match(nodes[2],/^upos-sz-mirrorhw\.bilivideo\.com +healthy +17\.02 +62 +0 +1 +5\.34 MiB +-$/,"then the healthy ones, fastest first");
  assert.deepEqual(nodes.slice(1,-1).map(line=>line.split(/ +/)[1]),["banned","healthy","healthy","healthy","healthy","untested","untested","untested","untested","unlisted","unlisted"]);
  assert.equal(nodes.at(-1),"address bans  none");
  const events=eventLines(text);
  assert.equal(lines.find(line=>line.startsWith("== Events ==")),`== Events ==  ${events.length} shown, 0 omitted`);
  assert.equal(section(text,"Events")[0],"       T  LEVEL  SOURCE  POS    EVENT");
  for(const line of [
    "   0.412  INFO   page      0.0  settings applied: full, mainland, threads auto",
    "   1.019  INFO   prev      0.0  session: qn 80 avc from 0.0",
    "   1.021  INFO   page      0.0  threads changed: 8 -> 16 (start with 16 threads)",
    "   1.024  DEBUG  page      0.0  native buffer locked: video",
    "   1.650  INFO   page      0.0  Bilibili replaced the video source: viewer at 0.0, paused",
    "   1.882  INFO   media     0.0  ratechange: 1.2x",
    "   2.402  WARN   page      0.0  range failed: video upos-sz-mirror08c.bilivideo.com after 0 KiB: Failed to fetch",
    "   2.721  INFO   player    0.0  ready to play: needed 2.5 s buffered",
    "   2.726  DEBUG  media     0.0  canplay"]) {
    assert.ok(events.includes(line),`Events has ${line}`);
  }
  const times=events.map(line=>Number(line.slice(0,8)));
  assert.deepEqual(times,times.slice().sort((a,b)=>a-b),"events are in time order");
  // At the same moment the page's records come before the player's: 2.721 first segment, then ready.
  assert.ok(events.indexOf("   1.024  INFO   page      0.0  took over: bv1ujxd69eks:p1")<events.indexOf("   1.024  DEBUG  page      0.0  native buffer locked: video"));
});

test("a source that is missing prints n/a, and {} or null never throw",()=>{
  for(const input of [{},null,undefined,42,"text",[],{video:null,settings:null,site:null,btr:null,env:null}]){
    const text=report.render(input);
    grammar(text,`render(${JSON.stringify(input)})`);
    assert.deepEqual(headings(text),["Summary","Checks","Environment","Site","Settings","Playback","Downloads","CDN nodes","Events","End"]);
    for(const line of section(text,"Summary")) assert.match(line,/  n\/a(?: \(setting n\/a\))?$|^engine +n\/a \(setting n\/a\)$/,`Summary: ${line}`);
    assert.ok(section(text,"Settings").every(line=>line.endsWith(" n/a")));
    assert.ok(section(text,"Site").every(line=>line.endsWith(" n/a")));
    assert.deepEqual(section(text,"Playback"),["n/a"]);
    assert.deepEqual(section(text,"CDN nodes"),["n/a"]);
    assert.deepEqual(section(text,"Checks"),["WARN  settings-not-loaded  the stored settings had not reached the page at capture"]);
    assert.deepEqual(section(text,"Events"),["none"]);
  }
  // Only the video module missing: its lines are n/a, the rest is printed.
  const partial=fixture();
  delete partial.video;
  const text=report.render(partial);
  grammar(text,"without video");
  assert.ok(section(text,"Summary").includes("state         n/a"));
  assert.ok(section(text,"Summary").includes("engine        n/a (setting full)"));
  assert.ok(section(text,"Downloads").includes("video         n/a"));
  assert.ok(section(text,"Downloads").includes("auto threads  16, level 2, 1 step, last change T+1.021 (start with 16 threads)"));
  assert.ok(section(text,"Settings").includes("threads              auto"));
});

test("values of the wrong type or out of range never throw and stay in the grammar",()=>{
  const garbage=[
    {capturedAt:"soon",now:NaN,timeOrigin:Infinity,btr:[],env:"x",settings:5,site:"CN",video:"x",media:{},live:"abc",readErrors:"x",autoThreads:[]},
    {video:{page:"x",timeline:[null,1,"a",{at:"abc",what:{},detail:[1,{a:{b:{c:1}}}]},{at:1e300,what:"x".repeat(5000),detail:"y".repeat(5000)}],playback:{currentTime:"1e400",buffered:[[1],[null,2],"x",[3,2]],frames:"x",lastPresentedFrame:[]},
      nodes:[null,{host:{}},{host:"a.b/c?d=e",state:{},bps:"fast"}],bannedNodes:"x",bans:[null,{kind:"address"}],downloads:{byKind:[],hosts:null,cancelReasons:{"":-1,"<script>":"x"}},player:{tracks:"x",qualities:"x",urlDeadline:-5,videoType:{}},
      nativeQuality:"80",previousPlayer:[],actualTakeover:"full",state:{},lastError:{}},
      stats:{takeoverError:{at:"x",stage:{},message:[]}},autoThreads:{trial:{},resting:[null,{}],startup:"x",steps:"many",changedAt:{}},
      live:[null,{frame:{},stats:{lastError:"直播分片为空",lastErrorAt:"x"},context:{hosts:[{host:"x"},null]},events:[{at:1,level:{},what:null}]}],
      media:[{name:{},detail:{code:"3",message:5}},{name:"error",detail:{code:3,message:"PIPELINE_ERROR_DECODE"}}],
      settings:{customHosts:"x",takeover:{},bufferAheadSeconds:"45"},site:{accountSites:[],userSite:"xx",lang:"zh-CN; SESSDATA=1",redirectsBlocked:"2"}}
  ];
  for(const [index,input] of garbage.entries()){
    const text=report.render(input);
    grammar(text,`garbage ${index}`);
  }
  // A snapshot whose getters throw still gives a report.
  const hostile={};
  Object.defineProperty(hostile,"video",{enumerable:true,get(){throw new Error("读取失败");}});
  grammar(report.render(hostile),"hostile");
  assert.match(report.render(hostile),/formatter failed/);
});

test("cookies, signatures and query strings never reach the text",()=>{
  const snapshot=fixture();
  const signed="https://upos-sz-mirrorhw.bilivideo.com/upgcxcode/16/15/1/1-1-100026.m4s?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=&uipk=5&nbs=1&deadline=1793783421&gen=playurlv2&os=hwbv&oi=2078815565&trid=a7b1&mid=12345&platform=pc&upsig=0f1e2d3c&uparams=e,uipk,nbs,deadline,gen,os,oi,trid,mid,platform&bvc=vod&nettype=0&buvid=XY12&build=0";
  snapshot.env.page="https://www.bilibili.com/video/BV1UjxD69EKs/?spm_id_from=333.1007&vd_source=abc#reply123";
  snapshot.env.userAgent+=" buvid3=XYZ-1234";
  snapshot.video.lastError=`range check failed: ${signed}`;
  snapshot.video.page.push({at:3000,time:0,what:"range failed",detail:`video //upos-sz-mirrorhw.bilivideo.com/x.m4s?deadline=1&upsig=2 after 0 KiB: ${signed}`,level:"warn"});
  snapshot.video.page.push({at:3100,time:0,what:"playback failed",detail:"cookie SESSDATA=abc%2C123; bili_jct=def456; DedeUserID=987654; DedeUserID__ckMd5=ff; sid=x",level:"error"});
  snapshot.video.downloads.hosts[host("mirrorhw")].lastError=`HTTP 403 at ${signed}`;
  snapshot.video.downloads.cancelReasons[`aborted ${signed}`]=1;
  snapshot.media.push({at:3200,name:"error",time:0,detail:`code 4: MEDIA_ELEMENT_ERROR: Format error ${signed}`});
  snapshot.site.lang="zh-CN; SESSDATA=1";
  snapshot.settings.customHosts=["upos-sz-mirrorhw.bilivideo.com/?upsig=1"];
  snapshot.readErrors=[`video: TypeError at ${signed}`];
  snapshot.live=[{frame:"iframe 1",timeOriginDelta:250,stats:{playerState:"ready",lastError:`直播分片响应异常：HTTP 403 ${signed}`,lastErrorAt:4000},context:{key:"/live-bvc/123/live_1_2/",lastNum:1,cached:2,hosts:[]},events:[{at:100,level:"error",what:"segment failed",detail:signed}]}];
  const text=report.render(snapshot);
  grammar(text,"privacy");
  assert.doesNotMatch(text,/upsig|deadline=|SESSDATA|bili_jct|DedeUserID=|buvid/i);
  assert.doesNotMatch(text,/(?:https?:)?\/\/[^\s"']*[?#]/,"no address keeps its query or fragment");
  assert.doesNotMatch(text,/987654|def456|vd_source|spm_id_from|reply123/);
  assert.ok(section(text,"Environment").includes("page         https://www.bilibili.com/video/BV1UjxD69EKs/"));
  assert.ok(section(text,"Site").includes("lang cookie  other"));
  // A space page's path is an account number, a favourites list's the number of someone's folder.
  for(const [page,shown] of [
    ["https://space.bilibili.com/12345678/favlist","https://space.bilibili.com/{id}/favlist"],
    ["https://space.bilibili.com/zh-Hant/12345678","https://space.bilibili.com/zh-Hant/{id}"],
    ["https://m.bilibili.com/space/12345678","https://m.bilibili.com/space/{id}"],
    ["https://www.bilibili.com/list/12345678","https://www.bilibili.com/list/{id}"],
    ["https://www.bilibili.com/list/ml12345678","https://www.bilibili.com/list/ml{id}"],
    ["https://www.bilibili.com/medialist/play/ml12345678","https://www.bilibili.com/medialist/play/ml{id}"],
    ["https://www.bilibili.com/list/watchlater","https://www.bilibili.com/list/watchlater"],
    ["https://www.bilibili.com/bangumi/play/ep12345","https://www.bilibili.com/bangumi/play/ep12345"]
  ]) {
    const masked=fixture();
    masked.env.page=page;
    assert.ok(section(report.render(masked),"Environment").includes(`page         ${shown}`),page);
  }
});

// Each Chinese text literal inside the parentheses of `name(`, at the given positions.
function literalsInCalls(source,pattern){
  const found=[];
  for(const match of source.matchAll(pattern)){
    const args=argumentsAt(source,match.index+match[0].length-1);
    for(const literal of args.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)){
      if(/[\u3000-\u9fff\uff00-\uffef]/.test(literal[0])) found.push(literal[0].slice(1,-1));
    }
  }
  return found;
}
function argumentsAt(source,open){
  let depth=0;
  for(let index=open;index<source.length;index+=1){
    const char=source[index];
    if(char==="\""||char==="'"||char==="`"){index=skipString(source,index);continue;}
    if(char==="(") depth+=1;
    else if(char===")"&&(depth-=1)===0) return source.slice(open+1,index);
  }
  return "";
}
function skipString(source,start){
  const quote=source[start];
  for(let index=start+1;index<source.length;index+=1){
    const char=source[index];
    if(char==="\\"){index+=1;continue;}
    if(quote==="`"&&char==="$"&&source[index+1]==="{"){
      let depth=1,inner=index+2;
      while(inner<source.length&&depth>0){
        const next=source[inner];
        if(next==="\""||next==="'"||next==="`"){inner=skipString(source,inner)+1;continue;}
        if(next==="{") depth+=1; else if(next==="}") depth-=1;
        inner+=1;
      }
      index=inner-1;
      continue;
    }
    if(char===quote) return index;
  }
  return source.length;
}

test("every Chinese message BTR throws or gives as a reason has English",()=>{
  const files=fs.readdirSync(SOURCE).filter(name=>name.endsWith(".js")&&name!=="diagnostic-report.js");
  const messages=new Map();
  for(const name of files){
    const source=fs.readFileSync(path.join(SOURCE,name),"utf8");
    for(const literal of literalsInCalls(source,/(?:\bnew\s+(?:Error|DOMException|RangeError|TypeError)|\babortError)\s*\(/g)) messages.set(literal,name);
    // 自动线程数's reasons: what its steps are called with, and the stalls the player reports.
    if(name==="idm-downloader.js"){
      for(const literal of literalsInCalls(source,/\b(?:stepUp|stepDown|setLevel|stall)\s*\(/g)) messages.set(literal,name);
      for(const match of source.matchAll(/\breason\s*[:=]\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g)) messages.set(match[1].slice(1,-1),name);
    }
    for(const literal of literalsInCalls(source,/\.stall\s*\(/g)) messages.set(literal,name);
  }
  assert.ok(messages.size>=50,`the scan found the messages (${messages.size})`);
  for(const message of ["并发副本已取消","播放器任务已取消","开头已经跟上，线程数降到 ${AUTO_LADDER[state.level - 1]}","前方缓冲快用完了"]) assert.ok(messages.has(message),`the scan sees ${message}`);
  for(const [message,file] of messages){
    const sample=message.replace(/\$\{[^}]*\}/g,"1");
    const english=report.translate(sample);
    assert.match(english,/^[\x20-\x7e]*$/,`${file}: ${sample} -> ${english}`);
    assert.ok(!english.includes("[non-English text]")&&english.trim(),`${file}: ${sample} has English (${english})`);
  }
});

test("translate keeps ASCII, numbers and hosts, and marks text it does not know",()=>{
  const cases=[
    ["Failed to fetch","Failed to fetch"],
    ["  spaced ascii stays as it is  ","  spaced ascii stays as it is  "],
    ["并发副本已取消","hedge lost"],
    ["开头已经跟上，线程数降到 8","start caught up, down to 8"],
    ["12 线程没有比 8 线程更快","12 threads were not faster than 8"],
    ["服务器返回 429","server returned HTTP 429"],
    ["Range 校验失败：HTTP 403","range check failed: HTTP 403"],
    ["媒体 Range 校验失败","media range check failed"],
    ["读取播放清单失败（HTTP 412）","playlist request failed (HTTP 412)"],
    ["子块长度不符：1024/2048","piece length mismatch: 1024/2048"],
    ["视频 SIDX 解析失败","video SIDX parse failed"],
    ["updateend 失败","updateend failed"],
    ["直播分片长度不对：收到 10，应为 20","live segment length wrong: got 10, expected 20"],
    ["原生播放器接口发生变化，已停止加速：原生调度接口不兼容","native player API changed, acceleration stopped: native scheduler API incompatible"],
    [`video ${host("estgoss")} after 0 KiB: 并发副本已取消`,`video ${host("estgoss")} after 0 KiB: hedge lost`],
    ["bv1ujxd69eks:p1 (兼容模式)","bv1ujxd69eks:p1 (compat)"],
    ["1080P 60帧 avc from 0.0","1080P60 avc from 0.0"],
    ["啥都木有 (-404)","[non-English text] (-404)"],
    ["请求错误 请稍后再试：HTTP 412","[non-English text]: HTTP 412"],
    ["café → x","caf? -> x"],
    [null,""],[undefined,""],[12,"12"],[{message:"已取消"},"cancelled"],[{},""]
  ];
  for(const [input,expected] of cases) assert.equal(report.translate(input),expected,JSON.stringify(input));
});

test("the pinned defaults are bridge.js DEFAULTS",()=>{
  const bridge=fs.readFileSync(path.join(SOURCE,"bridge.js"),"utf8");
  const match=/const DEFAULTS = (\{[^;]*\});/.exec(bridge);
  assert.ok(match,"bridge.js DEFAULTS found");
  const defaults=vm.runInNewContext(`(${match[1]})`);
  assert.deepEqual(JSON.parse(JSON.stringify(report.DEFAULTS)),JSON.parse(JSON.stringify(defaults)));
  // Changed settings are marked, unchanged ones not.
  const snapshot=fixture();
  Object.assign(snapshot.settings,{autoConcurrency:false,concurrency:16,mode:"custom",customHosts:["cn-hk-eq-01-13.bilivideo.com"],bufferAheadSeconds:90});
  const settings=section(report.render(snapshot),"Settings");
  for(const line of ["threads              16 *","cdn                  custom *","custom hosts         cn-hk-eq-01-13.bilivideo.com *","buffer ahead         90 s *"]) assert.ok(settings.includes(line),line);
  assert.ok(section(report.render(snapshot),"Downloads").includes("auto threads  off (manual 16)"));
});

test("1000 events stay within 400 lines and keep every WARN and ERROR",()=>{
  const snapshot=fixture();
  const page=[],timeline=[],media=[];
  const wanted=[];
  for(let index=0;index<1000;index+=1){
    const at=5000+index*37;
    const level=index%23===0?"error":index%11===0?"warn":index%2?"debug":"info";
    const entry={at,time:Math.round(index*3.7)/10,what:`event ${index}`,detail:`detail ${index}`,level};
    if(level==="warn"||level==="error") wanted.push(`event ${index}: detail ${index}`);
    if(index%3===0) page.push(entry);
    else if(index%3===1) timeline.push(entry);
    else media.push({at,name:`event ${index}`,time:entry.time,detail:entry.detail,level});
  }
  Object.assign(snapshot.video,{page,timeline,previousPlayer:null});
  snapshot.media=media;
  const text=report.render(snapshot);
  grammar(text,"1000 events");
  const events=eventLines(text);
  assert.ok(events.length<=400,`${events.length} event lines`);
  const [,shown,omitted]=/^== Events ==  (\d+) shown, (\d+) omitted$/.exec(text.split("\n").find(line=>line.startsWith("== Events ==")));
  assert.equal(Number(shown),events.length);
  assert.equal(Number(shown)+Number(omitted),1000);
  for(const message of wanted) assert.ok(events.some(line=>line.endsWith(message)),`${message} is kept`);
  assert.ok(!events.some(line=>/  DEBUG  /.test(line)),"DEBUG goes first");
  const infos=events.filter(line=>/  INFO  /.test(line));
  assert.ok(infos.length>0&&infos.every(line=>Number(line.slice(0,8))>=Number(events.find(other=>/  INFO  /.test(other)).slice(0,8))),"the newest INFO lines stay");
  assert.ok(infos.at(-1).endsWith("event 998: detail 998"),"the newest INFO is the last one");
});

test("repeats fold into one line with a count",()=>{
  const snapshot=fixture();
  const page=[];
  for(let index=0;index<20;index+=1) page.push({at:5000+index*100,time:1,what:"native buffer locked",detail:"video",level:"debug"});
  page.push({at:16000,time:1,what:"native buffer locked",detail:"video",level:"debug"});
  page.push({at:17000,time:2,what:"page was in the background",detail:"3.0 s",level:"info",count:3});
  Object.assign(snapshot.video,{page,timeline:[],previousPlayer:null});
  snapshot.media=[];
  const events=eventLines(report.render(snapshot));
  assert.deepEqual(events,[
    "   5.000  DEBUG  page      1.0  native buffer locked: video (x20 until T+6.900)",
    "  16.000  DEBUG  page      1.0  native buffer locked: video",
    "  17.000  INFO   page      2.0  page was in the background: 3.0 s (x3)"
  ]);
});

test("a long line keeps its repeat count, and each read error has its own line",()=>{
  const snapshot=fixture();
  const page=[0,1,2].map((index)=>({at:5000+index*100,time:1,what:"range failed",detail:`video ${"x".repeat(240)}`,level:"warn"}));
  Object.assign(snapshot.video,{page,timeline:[],previousPlayer:null});
  snapshot.media=[];
  snapshot.readErrors=[`video: ${"y".repeat(150)}`,"live: blocked by the frame"];
  const text=report.render(snapshot);
  grammar(text,"long lines");
  const [line]=eventLines(text);
  assert.ok(line.length<=200&&line.endsWith("... (x3 until T+5.200)"),line);
  const environment=section(text,"Environment");
  assert.equal(environment.filter(row=>row.startsWith("read error ")).length,2);
  assert.ok(environment.includes("read error   live: blocked by the frame"));
});

test("a page without a video has no engine, and the player's own failures keep their level",()=>{
  const home=fixture();
  Object.assign(home.video,{actualTakeover:"native",videoPage:false,playback:null,player:{}});
  let text=report.render(home);
  assert.ok(section(text,"Summary").includes("engine        n/a (setting full)"));
  assert.ok(!section(text,"Checks").some(line=>line.includes("engine-differs")));
  const failing=fixture();
  failing.video.timeline=[{at:9000,time:150,what:"end of stream failed",detail:"40 attempts: InvalidStateError"},{at:9100,time:0,what:"autoplay refused",detail:"NotAllowedError"}];
  failing.video.page=[];failing.media=[];failing.video.previousPlayer=null;
  text=report.render(failing);
  assert.ok(eventLines(text).some(line=>/  ERROR  player  .*end of stream failed: 40 attempts: InvalidStateError$/.test(line)));
  assert.ok(eventLines(text).some(line=>/  WARN   player  .*autoplay refused: NotAllowedError$/.test(line)));
});

test("a long report is cut to 48000 chars and long lines to 200",()=>{
  const snapshot=fixture();
  const page=[];
  for(let index=0;index<1500;index+=1) page.push({at:5000+index,time:0,what:"range failed",detail:`video ${"x".repeat(150)} ${index}`,level:"warn"});
  Object.assign(snapshot.video,{page,timeline:[],previousPlayer:null});
  snapshot.env.userAgent="Mozilla/5.0 ".repeat(40);
  snapshot.video.nodes=Array.from({length:60},(_,index)=>({host:`node-${index}.bilivideo.com`,state:"untested",bps:0}));
  Object.assign(snapshot.video,{bannedNodes:[],bans:[]});
  snapshot.video.downloads.hosts={};
  const text=report.render(snapshot);
  const lines=grammar(text,"long");
  assert.ok(lines.some(line=>line.startsWith("browser")&&line.endsWith("...")&&line.length===200));
  assert.ok(section(text,"CDN nodes").includes("20 more"),"at most 40 node rows");
  assert.match(lines.find(line=>line.startsWith("== Events ==")),/^== Events ==  \d+ shown, \d+ omitted$/);
});

test("compat, native, live and a takeover failure print their own lines",()=>{
  const compat=fixture();
  compat.settings.takeover="compat";
  Object.assign(compat.video,{actualTakeover:"compat",player:{architecture:"native-player-range-transport",transportRevision:6,qualityGuardRevision:11,nativeQualityGuard:true,qualityId:80,downloadedQualityId:64,width:1920,height:1080,currentTime:3,videoType:"video/mp4",audioType:"audio/mp4",videoBandwidth:900000,audioBandwidth:130000,codec:"avc1.640028",frameRate:29.97,acceleratedRanges:40,failedRanges:1,nativeSwitchRequests:2,nativeQuality:"80/80/80",nativeSwitchPending:false,activeRequests:3,timeline:[]}});
  let text=report.render(compat);
  grammar(text,"compat");
  assert.ok(section(text,"Summary").includes("video         avc1.640028 1920x1080 29.97 fps 0.90 Mbit/s"));
  assert.ok(section(text,"Summary").includes("quality       playing qn 64 (720P), menu auto (shows qn 80)"));
  for(const line of ["transport        revision 6, quality guard yes (revision 11)","ranges           40 served, 1 failed, 3 active","quality pick     downloaded qn 64 (720P), menu now 80 new 0 real 80, core now/target/rendered 80/80/80","ready state      4 HAVE_ENOUGH_DATA"]) assert.ok(section(text,"Playback").includes(line),line);

  const native=fixture();
  Object.assign(native.video,{actualTakeover:"native",player:{}});
  text=report.render(native);
  assert.deepEqual(section(text,"Playback"),["ready state    4 HAVE_ENOUGH_DATA","network state  1 IDLE","buffered       0.0-5.1"]);
  assert.ok(section(text,"Checks").includes("INFO  engine-differs       setting full, running native"));

  const failed=fixture();
  failed.video.state="error";
  failed.video.lastError="读取播放清单失败（HTTP 412）";
  failed.stats.takeoverError={at:CAPTURED-10000,route:"bv1ujxd69eks:p1",stage:"playinfo",message:"读取播放清单失败（HTTP 412）",retryCount:2};
  failed.video.playback.mediaError={code:3,message:"PIPELINE_ERROR_DECODE"};
  failed.video.playback.visibility="hidden";
  Object.assign(failed.video.nativeQuality,{newQ:64});
  failed.video.player.qualityId=80;
  failed.btr.otherBuild="canary";
  failed.site={...failed.site,international:true,redirectsBlocked:2,gaveUp:true};
  failed.settings.blockInternational=true;
  failed.live=[{frame:"iframe 1",timeOriginDelta:500,stats:{playerState:"ready",acceleratedRequests:12,acceleratedBytes:3500000,activeThreads:2,totalSpeedBps:250000,lastError:"直播分片首字节超时",lastErrorAt:1500},
    context:{key:"/live-bvc/123/live_1_2/",lastNum:4521,cached:6,hosts:[{host:"cn-hk-eq-01-13.bilivideo.com",state:"healthy",bps:300000},{host:"d1--cn-gotcha04.bilivideo.com",state:"banned",bps:0}]},
    events:[{at:1500,level:"warn",what:"segment failed",detail:"直播分片首字节超时"}]}];
  text=report.render(failed);
  grammar(text,"failure");
  assert.deepEqual(section(text,"Checks"),[
    "ERROR takeover-failed      playinfo: playlist request failed (HTTP 412) (attempt 2, at T+8.042)",
    "ERROR media-error          3 MEDIA_ERR_DECODE: PIPELINE_ERROR_DECODE",
    "WARN  node-banned          upos-sz-mirror08c.bilivideo.com: 2 failures with no data (Failed to fetch)",
    "WARN  range-failures       2 failed requests on 1 node",
    "WARN  quality-mismatch     menu qn 64 (720P), playing qn 80 (1080P)",
    "WARN  other-build          the canary build is enabled too and is not running on this page",
    "WARN  site-international   international page while block international is on",
    "WARN  site-gave-up         BTR stopped sending this tab back to the domestic site",
    "WARN  live-error           iframe 1: live segment first byte timed out",
    "INFO  redirects-blocked    2 redirects to the international site blocked",
    "INFO  source-replaced      Bilibili replaced the video source 1 time (last at T+1.650)",
    "INFO  tab-hidden           the tab was hidden at capture"
  ]);
  assert.ok(section(text,"Summary").includes("last error    playlist request failed (HTTP 412)"));
  const live=section(text,"Live (iframe 1)");
  for(const line of ["state         ready","stream        /live-bvc/123/live_1_2/","requests      12, 3.34 MiB","speed         2.00 Mbit/s","last error    live segment first byte timed out at T+2.000"]) assert.ok(live.includes(line),line);
  assert.match(live.find(line=>line.startsWith("d1--")),/^d1--cn-gotcha04\.bilivideo\.com +banned +-$/);
  assert.ok(eventLines(text).includes("   2.000  WARN   live        -  segment failed: live segment first byte timed out"));
});
