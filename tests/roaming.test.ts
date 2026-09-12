import { describe, expect, it, vi } from "vitest";
import * as gitProbe from "../src/core/git.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../src/index.js";
import { hasAstGrep } from "../src/core/astgrep.js";
import { getState, getInflight, evictState, ensureState, focus, dwell } from "../src/core/ops.js";
import { sync, syncBaselineStore } from "../src/core/sync.js";
import { getSession } from "../src/core/session.js";
import { WORKSPACE_ACCESS_EVENT } from "../src/workspace.js";

const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), "fovea-many-roots-")));
const initial = "export function entry() { return 'original'; }\n";
function gitRepo(parent:string, name:string):string {
  const root=join(parent,name); mkdirSync(root,{recursive:true}); writeFileSync(join(root,"entry.ts"),initial);
  const git=(args:string[])=>execFileSync("git",args,{cwd:root,stdio:"ignore"});
  git(["init","-qb","main"]); git(["-c","core.hooksPath=/dev/null","add","."]);
  git(["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false","-c","user.name=probe","-c","user.email=probe@example.invalid","commit","-qm","test(fixture): initialize"]);
  return root;
}
function host(cwd:string) {
  const tools=new Map<string,any>(), handlers=new Map<string,any[]>(), entries:any[]=[], messages:any[]=[], bus=new Map<string,Set<(data:unknown)=>void>>();
  const ctx={cwd,hasUI:false,isProjectTrusted:()=>false,isIdle:()=>true,ui:{notify:()=>{}},sessionManager:{getSessionId:()=>"roaming-test",getBranch:()=>entries}};
  const api={on:(name:string,fn:any)=>handlers.set(name,[...(handlers.get(name)??[]),fn]),registerTool:(tool:any)=>tools.set(tool.name,tool),registerCommand:()=>{},
    appendEntry:(customType:string,data:unknown)=>entries.push({type:"custom",customType,data}),sendMessage:(message:unknown,options:unknown)=>messages.push({message,options}),
    events:{on:(name:string,fn:(data:unknown)=>void)=>{const set=bus.get(name)??new Set();set.add(fn);bus.set(name,set);return()=>{set.delete(fn);};},emit:(name:string,data:unknown)=>{for(const fn of bus.get(name)??[])fn(data);}}};
  extension(api as never);
  const emit=async(name:string,event:Record<string,unknown>={})=>{const result=[];for(const fn of handlers.get(name)??[])result.push(await fn(event,ctx));return result;};
  const read=(root:string,error=false)=>emit("tool_result",{toolName:"read",toolCallId:"read",input:{path:join(root,"entry.ts")},isError:error});
  return {tools,ctx,entries,messages,api,emit,read};
}

describe("local-only Git observation",()=>{
  it("does not execute repository fsmonitor or lazy-fetch helpers",async()=>{
    const parent=fixture(),root=gitRepo(parent,"repo"),sentinel=join(parent,"executed"),helper=join(root,".git/observer-helper");
    const config=(key:string,value:string)=>execFileSync("git",["-C",root,"config",key,value],{stdio:"ignore"});
    try {
      writeFileSync(helper,`#!/bin/sh\ntouch '${sentinel}'\nprintf '\\000'\n`,{mode:0o755});
      config("core.fsmonitor",helper);
      expect(await gitProbe.gitOut(root,["status","--porcelain"])).toBeDefined();expect(existsSync(sentinel)).toBe(false);
      config("remote.origin.url",`ext::${helper}`);config("remote.origin.promisor","true");config("protocol.ext.allow","always");
      expect(await gitProbe.gitOut(root,["cat-file","-p","1234567890123456789012345678901234567890"])).toBeUndefined();
      expect(existsSync(sentinel)).toBe(false);
    } finally {rmSync(parent,{recursive:true,force:true});}
  });
});

describe.skipIf(!hasAstGrep())("roaming observation", () => {
  it("automatically cycles through more than 32 disjoint/nested repos without indexing the launcher", async () => {
    const origin=fixture(), elsewhere=fixture(), h=host(origin), roots:string[]=[];
    try {
      await h.emit("session_start"); await h.emit("before_agent_start"); expect(getState(origin)).toBeUndefined();
      for(let i=0;i<35;i++) roots.push(gitRepo(i%2?elsewhere:origin,`group/project-${i}`));
      await h.read(roots[0]!,true); expect(syncBaselineStore().has(roots[0]!)).toBe(false);
      for(const root of roots) await h.read(root);
      const saved=h.entries.at(-1).data; expect(saved.roots).toHaveLength(32); expect(saved.roots).toEqual(roots.slice(3));
      expect(syncBaselineStore().size).toBe(32); expect(syncBaselineStore().has(roots[0]!)).toBe(false);
      expect(getState(origin)).toBeUndefined(); expect(getState(elsewhere)).toBeUndefined();
      writeFileSync(join(roots[0]!,"entry.ts"),"export function inactiveChange() {}\n");
      await h.read(roots[0]!);
      expect(syncBaselineStore().has(roots[0]!)).toBe(true);
      expect(h.entries.at(-1).data.roots.at(-1)).toBe(roots[0]);
      const quiet=await sync(roots[0]!,{budget:512,steerThreshold:0.01,sessionId:"roaming-test"});
      expect(quiet.red).toBe(false); // Re-entry is a new baseline, not an invented inactive delta.
      const [notice]=await h.emit("before_agent_start"); expect(notice.message.content).toContain("retirement");
      expect(Math.ceil(notice.message.content.length/4)).toBeLessThanOrEqual(1024);
      h.api.events.emit(WORKSPACE_ACCESS_EVENT,{version:1,source:"contour",root:origin,sessionId:"another-session"});
      expect(h.entries.at(-1).data.roots).not.toContain(origin);
      h.api.events.emit(WORKSPACE_ACCESS_EVENT,{version:1,source:"contour",root:roots[1],sessionId:"roaming-test"});
      const peer=await h.tools.get("fovea_sketch").execute("peer",{maxTokens:256},new AbortController().signal,undefined,h.ctx);
      expect(peer.details.root).toBe(roots[1]);
      await h.emit("session_compact"); const checkpoint=h.entries.at(-1).data;
      await h.emit("session_shutdown"); await h.emit("session_start");
      expect(syncBaselineStore().size).toBe(0);
      const result=await h.tools.get("fovea_sketch").execute("restored",{maxTokens:256},new AbortController().signal,undefined,h.ctx);
      expect(result.details.root).toBe(checkpoint.roots.at(-1)); expect(result.details.workspace.capacity).toBe(32);
    } finally { await h.emit("session_shutdown"); for(const root of roots)evictState(root); rmSync(origin,{recursive:true,force:true});rmSync(elsewhere,{recursive:true,force:true}); }
  },60_000);

  it("keeps cold Git baselines without rebuilding and notices a dirty-to-clean revert", async () => {
    const parent=fixture(), h=host(parent), roots:string[]=[];
    try {
      for(let i=0;i<5;i++) roots.push(gitRepo(parent,`repo-${i}`));
      writeFileSync(join(roots[0]!,"entry.ts"),"export function entry() { return 'dirty'; }\n");
      for(const root of roots) await h.read(root);
      const probe=vi.spyOn(gitProbe,"gitProbe");
      for(const root of roots.slice(0,3)) {
        expect((await sync(root,{budget:512,steerThreshold:0.01},undefined,{probe:"defer"})).details).toMatchObject({cold:true,deferred:true});
      }
      expect(probe).not.toHaveBeenCalled(); probe.mockRestore();
      for(const root of roots.slice(0,3)) {
        expect(getState(root)).toBeUndefined();
        const result=await sync(root,{budget:512,steerThreshold:0.01,sessionId:"roaming-test"});
        expect(result.details).toMatchObject({cold:true}); expect(getInflight(root)).toBeUndefined();
      }
      writeFileSync(join(roots[0]!,"entry.ts"),initial);
      expect((await sync(roots[0]!,{budget:512,steerThreshold:0.01})).details.indexing).toBe(true);
      const updated=await getInflight(roots[0]!)!;
      const delta=await sync(roots[0]!,{budget:512,steerThreshold:0.01,sessionId:"roaming-test"},updated);
      expect(delta.structural).toBe(true); expect(delta.details.changedFiles).toContain("entry.ts");
      const before=syncBaselineStore().get(roots[1]!);
      const cancelled=await sync(roots[1]!,{budget:512,steerThreshold:0.01},undefined,{current:()=>false});
      expect(cancelled.details.cancelled).toBe(true); expect(syncBaselineStore().get(roots[1]!)).toBe(before);
    } finally { await h.emit("session_shutdown");for(const root of roots)evictState(root);rmSync(parent,{recursive:true,force:true}); }
  },30_000);

  it("pages numerical vectors without losing independent focus/attention", async () => {
    const parent=fixture(), roots:string[]=[];
    try {
      for(let i=0;i<3;i++) {const root=gitRepo(parent,`repo-${i}`);roots.push(root);await focus(root,"entry",256);}
      expect(getSession(roots[0]!).tk).toHaveLength(0);
      expect(getSession(roots[0]!).seeds.length).toBeGreaterThan(0);
      const result=await dwell(roots[0]!,2,256);
      expect(result.details.staleFocus).toBeUndefined(); expect(result.text).toContain("context widened");
      expect(roots.filter(root=>getSession(root).tk.length).length).toBeLessThanOrEqual(2);
      expect((await ensureState(roots[0]!)).root).toBe(roots[0]);
    } finally {for(const root of roots)evictState(root);rmSync(parent,{recursive:true,force:true});}
  });
});
