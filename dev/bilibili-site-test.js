"use strict";
// bilibili-site.js: the BV number of an av number, checked against pairs Bilibili itself shows.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
function load(){
  const context=vm.createContext({URL,Intl});
  context.globalThis=context;
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/bilibili-site.js"),"utf8"),context,{filename:"bilibili-site.js"});
  return context.__BTR_BILIBILI_SITE__;
}

test("international addresses go back to the same page on the domestic site, space pages included (#68)",()=>{
  const {domesticAddress}=load();
  for(const [from,to] of [
    ["https://www.bilibili.com/en/video/BV1xx/","https://www.bilibili.com/video/BV1xx/"],
    ["https://www.bilibili.com/zh-Hans/","https://www.bilibili.com/"],
    ["https://www.bilibili.com/?site=OVERSEAS&lang=en","https://www.bilibili.com/"],
    ["https://space.bilibili.com/en/2","https://space.bilibili.com/2"],
    ["https://space.bilibili.com/EN/2/video?tid=3","https://space.bilibili.com/2/video?tid=3"],
    ["https://space.bilibili.com/2?site=OVERSEAS&lang=en","https://space.bilibili.com/2"],
    ["https://www.bilibili.com/video/BV1xx/",""],
    ["https://space.bilibili.com/2",""],
    ["https://space.bilibili.com/my/2",""],
    ["https://game.bilibili.com/sr/",""]
  ]) assert.equal(domesticAddress(from),to,from);
});

test("a navigation from a domestic page to the same page on the international site is recognised (#68)",()=>{
  const {isSiteRedirect}=load();
  assert.equal(isSiteRedirect("https://www.bilibili.com/en/video/BV1xx/","https://www.bilibili.com/video/BV1xx/"),true);
  assert.equal(isSiteRedirect("https://www.bilibili.com/en/video/BV1xx/?p=2","https://www.bilibili.com/video/BV1xx/?p=2"),true);
  assert.equal(isSiteRedirect("https://space.bilibili.com/en/2","https://space.bilibili.com/2"),true);
  assert.equal(isSiteRedirect("https://www.bilibili.com/en","https://www.bilibili.com/"),true);
  assert.equal(isSiteRedirect("https://www.bilibili.com/en/video/BV2xx/","https://www.bilibili.com/video/BV1xx/"),false,"another video");
  assert.equal(isSiteRedirect("https://www.bilibili.com/video/BV2xx/","https://www.bilibili.com/video/BV1xx/"),false,"domestic to domestic");
  assert.equal(isSiteRedirect("https://www.bilibili.com/video/BV1xx/","https://www.bilibili.com/en/video/BV1xx/"),false,"back to the domestic site");
  assert.equal(isSiteRedirect("https://space.bilibili.com/en/2","https://www.bilibili.com/video/BV1xx/"),false,"another host");
  // Bilibili builds the international address with the query exactly as it was written.
  for(const query of ["?keyword=a%20b","?a=b,c","?autoplay","?a=1&","?spm_id_from=333.1007.0.0&vd_source=abc"])
    assert.equal(isSiteRedirect(`https://www.bilibili.com/en/video/BV1xx/${query}`,`https://www.bilibili.com/video/BV1xx/${query}`),true,query);
});

test("av numbers become the BV numbers of the same videos, old and new",()=>{
  const {avToBv}=load();
  for(const [aid,bvid] of [[170001,"BV17x411w7KC"],[80433022,"BV1GJ411x7h7"],[116937933723543,"BV1T1NZ6xEZZ"],[117443867451009,"BV1ysJ16HEHP"],[116090818598734,"BV1f3Z9BoEYu"]]){
    assert.equal(avToBv(aid),bvid);
    assert.equal(avToBv(String(aid)),bvid);
  }
});

test("anything that is no av number gives nothing",()=>{
  const {avToBv}=load();
  for(const value of [0,-1,"","abc","12a",1.5,2**51,"99999999999999999",null,undefined]) assert.equal(avToBv(value),"");
});
