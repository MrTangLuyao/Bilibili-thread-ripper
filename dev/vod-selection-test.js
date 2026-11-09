"use strict";
// Track selection of the full-takeover player: Dolby/Hi-Res sources keep their audio in
// dash.dolby.audio / dash.flac.audio, and HDR/8K video representations are selectable.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=path.join(__dirname,"../src");
function load(unsupportedCodecs=[]){
  const context=vm.createContext({URL,console,document:undefined,performance});
  context.globalThis=context;
  context.MediaSource={isTypeSupported:(mime)=>!unsupportedCodecs.some(codec=>mime.includes(codec))};
  context.__BILI_RANGE_CORE__={parseByteRange:()=>null,normalizeSettings:(x)=>x};
  context.__BILI_SIDX__={};
  context.__BILI_CDN_RESOLVER_FACTORY__={};
  context.__BILI_IDM_DOWNLOADER_FACTORY__={};
  vm.runInContext(fs.readFileSync(path.join(SOURCE,"native-mse-player.js"),"utf8"),context,{filename:"native-mse-player.js"});
  return context.__BILI_NATIVE_MSE_PLAYER_FACTORY__;
}
const video=(id,codecs,height,bandwidth=1e6)=>({id,codecs,height,width:Math.round(height*16/9),bandwidth,mimeType:"video/mp4",baseUrl:`https://upos-sz-mirrorali.bilivideo.com/${id}.m4s`});
const audio=(id,codecs,bandwidth)=>({id,codecs,bandwidth,mimeType:"audio/mp4",baseUrl:`https://upos-sz-mirrorali.bilivideo.com/a${id}.m4s`});

test("a Dolby/Hi-Res source with empty dash.audio picks its flac or dolby track",()=>{
  const factory=load(["ec-3"]);
  const playinfo={data:{quality:125,dash:{
    video:[video(125,"hev1.2.4.L153.b0",2160),video(80,"avc1.640028",1080)],
    audio:[],
    flac:{display:true,audio:[audio(30251,"fLaC",1500000)]},
    dolby:{type:2,audio:[audio(30250,"ec-3",640000)]}
  }}};
  const selection=factory.selectRepresentations(playinfo,0,"");
  assert.equal(Number(selection.audio.id),30251,"flac is picked when ordinary audio is missing and ec-3 is unsupported");
  assert.equal(Number(selection.preferred.id),125,"the HDR representation the playinfo asks for is kept");
});

test("ordinary audio stays preferred over flac when both exist",()=>{
  const factory=load([]);
  const playinfo={data:{quality:80,dash:{
    video:[video(80,"avc1.640028",1080)],
    audio:[audio(30280,"mp4a.40.2",320000)],
    flac:{display:true,audio:[audio(30251,"fLaC",1500000)]}
  }}};
  assert.equal(Number(factory.selectRepresentations(playinfo,0,"").audio.id),30280);
});

test("an explicitly chosen 8K representation is used; auto avoids 8K",()=>{
  const factory=load([]);
  const playinfo={data:{quality:127,dash:{
    video:[video(127,"hev1.1.6.L183.90",4320,3e7),video(120,"hev1.1.6.L153.90",2160,1e7),video(80,"avc1.640028",1080)],
    audio:[audio(30280,"mp4a.40.2",320000)]
  }}};
  assert.equal(Number(factory.selectRepresentations(playinfo,127,"").preferred.id),127,"user-picked 8K wins");
  assert.equal(Number(factory.selectRepresentations(playinfo,0,"").preferred.id),127,"the playinfo's own requested quality wins on auto");
  const noRequested={data:{quality:0,dash:playinfo.data.dash}};
  assert.equal(Number(factory.selectRepresentations(noRequested,0,"").preferred.id),120,"otherwise auto stays at 4K or below");
});

test("自动 plays the quality the native player shows, not the one the playinfo asked for (#69)",()=>{
  const factory=load(["avc1.64002a"]);
  const playinfo={data:{quality:64,dash:{
    video:[video(116,"avc1.64002a",1080),video(80,"av01.0.08M.08",1080),video(80,"avc1.640028",1080),video(64,"av01.0.05M.08",720),video(32,"avc1.64001f",480)],
    audio:[audio(30280,"mp4a.40.2",320000)]
  }}};
  const pick=(...args)=>{const chosen=factory.selectRepresentations(playinfo,...args).preferred;return `${chosen.id} ${chosen.codecs}`;};
  assert.equal(pick(0,"",0,80),"80 av01.0.08M.08","the shown quality, in the preferred codec");
  assert.equal(pick(0,"",0,0),"64 av01.0.05M.08","not known yet: the playinfo's own, as before");
  assert.equal(pick(32,"",0,80),"32 avc1.64001f","a quality chosen by hand wins");
  assert.equal(pick(0,"",0,116),"80 av01.0.08M.08","a shown quality this browser cannot play: the best at or below its height");
  assert.equal(pick(0,"",0,0,32),"32 avc1.64001f","not known: the quality already playing stays when the playinfo is refreshed");
  assert.equal(pick(0,"",0,80,32),"80 av01.0.08M.08","known: the shown quality wins over the one playing");
});

test("playback deadlines are absolute and account for playback speed",()=>{
  const factory=load([]);
  assert.equal(factory.playbackDeadlineAt(10,4,2,1000),4000,"six media seconds at 2x are three wall-clock seconds");
  assert.equal(factory.playbackDeadlineAt(4,10,2,1000),1000,"an overdue segment keeps the entry timestamp");
});
