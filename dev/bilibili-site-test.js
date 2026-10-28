"use strict";
// bilibili-site.js: the BV number of an av number, checked against pairs Bilibili itself shows.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
function load(){
  const context=vm.createContext({URL,Intl});
  context.globalThis=context;
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/bilibili-site.js"),"utf8"),context,{filename:"bilibili-site.js"});
  return context.__BTR_BILIBILI_SITE__;
}

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
