import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { ExecutionRoots, ProjectDiscovery, accessedPaths, canonicalPath, latestWorkspaceEntry, peerWorkspaceRoot } from "../src/workspace.js";

const temporary: string[] = [];
const folder = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), "fovea-roaming-"))); temporary.push(path); return path; };
const source = (root: string, name = "src/a.ts") => { const path = join(root, name); mkdirSync(join(path, ".."), {recursive:true}); writeFileSync(path, "export const a = 1;\n"); return path; };
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, {recursive:true, force:true}); });

describe("bounded workspace ring", () => {
  it("retains the 32 most recently used roots and explicitly retires old leases", () => {
    const parent=folder(), ring=new ExecutionRoots();
    expect(ring.capacity).toBe(32); expect(ring.list(parent)).toEqual([]);
    const roots=Array.from({length:40},(_,i)=>{const root=join(parent,String(i));mkdirSync(root);return root;});
    for (const root of roots.slice(0,32)) ring.bind(root);
    const oldLease=ring.lease(roots[1]!); ring.bind(roots[0]!);
    expect(ring.bind(roots[32]!)).toMatchObject({fresh:true,evicted:roots[1]});
    expect(ring.has(roots[0]!)).toBe(true); expect(ring.lease(roots[1]!)).toBeUndefined();
    ring.bind(roots[1]!); expect(ring.lease(roots[1]!)).not.toBe(oldLease);
    for (let i=0;i<150;i++) ring.bind(roots[i%40]!);
    expect(ring.list()).toHaveLength(32); expect(ring.details().retiredRoots.length).toBeLessThanOrEqual(32);
    expect(ring.details().continuity).toContain("fresh baseline");
  });
  it("normalizes symlinks, leaves worktrees distinct, and restores only bounded metadata", () => {
    const cwd=folder(), a=folder(), b=folder(), alias=join(cwd,"alias"); symlinkSync(a,alias,"dir");
    const ring=new ExecutionRoots(2); ring.bind(canonicalPath(cwd,alias)); ring.bind(b);
    expect(ring.owner(cwd,join(alias,"new.ts"))).toEqual({root:a,path:"new.ts"});
    expect(ring.target(cwd)).toBe(b); expect(ring.target(cwd,".")).toBe(cwd);
    const restored=new ExecutionRoots(2); restored.restore(ring.snapshot());
    expect(restored.recent()).toEqual([a,b]); expect(restored.target(cwd)).toBe(b);
    restored.restore({version:1,roots:["relative",...Array.from({length:99},(_,i)=>`/nonexistent-${i}`)]});
    expect(restored.list()).toHaveLength(2); expect(()=>new ExecutionRoots(33)).toThrow("1..32");
    restored.clear(); expect(restored.owner(cwd,join(a,"new.ts"))).toBeUndefined();
  });
  it("keeps session-qualified peer hints and branch snapshots distinct from arbitrary text", () => {
    const root=folder(); const data={version:1,source:"contour",root,sessionId:"s"};
    expect(peerWorkspaceRoot(data,"s","fovea")).toBe(root);
    expect(peerWorkspaceRoot(data,"other","fovea")).toBeUndefined();
    expect(peerWorkspaceRoot(data,"s","contour")).toBeUndefined();
    expect(peerWorkspaceRoot({...data,root:"../unsafe"},"s","fovea")).toBeUndefined();
    const entry={type:"custom",customType:"roots",data:{version:1,roots:[root]}};
    expect(latestWorkspaceEntry([entry,{type:"message",content:"roots /elsewhere"}],"roots")).toEqual(entry.data);
  });
});

describe("safe demand-driven discovery", () => {
  it("finds nested/disjoint Git projects and worktree markers without scanning a parent", async () => {
    const parent=folder(), a=folder(), nested=join(parent,"group/child");
    mkdirSync(join(a,".git")); mkdirSync(nested,{recursive:true}); writeFileSync(join(nested,".git"),"gitdir: /elsewhere\n");
    const fileA=source(a), fileB=source(nested), discovery=new ProjectDiscovery();
    expect(await discovery.discover(parent,parent)).toBeUndefined();
    expect(await discovery.discover(parent,fileA)).toEqual({root:a,git:true});
    expect(await discovery.discover(parent,fileB)).toEqual({root:nested,git:true});
    const alias=join(parent,"alias"); symlinkSync(a,alias,"dir");
    expect(await discovery.discover(parent,join(alias,"src/a.ts"))).toEqual({root:a,git:true});
  });
  it("prefers Git boundaries over nested manifests and safely scopes plain sources", async () => {
    const root=folder(); mkdirSync(join(root,".git")); const file=source(root);
    writeFileSync(join(root,"src/package.json"),"{}"); const discovery=new ProjectDiscovery();
    expect((await discovery.discover(root,file))?.root).toBe(root);
    const plain=folder(), standalone=source(plain); expect(await discovery.discover(root,standalone)).toEqual({root:join(plain,"src"),git:false});
    expect(await discovery.discover(root,standalone,true)).toBeUndefined();
    writeFileSync(join(plain,"package.json"),"{}"); discovery.clear();
    expect(await discovery.discover(root,standalone)).toEqual({root:plain,git:false});
  });
  it("does not enroll broad, private, dependency, missing, or output-supplied paths", async () => {
    const root=folder(); mkdirSync(join(root,".git")); const discovery=new ProjectDiscovery();
    for (const path of ["node_modules/pkg/a.ts",".pi/private.ts",".ssh/key.ts",".env.production"]) {
      const file=source(root,path); expect(await discovery.discover(root,file)).toBeUndefined();
    }
    for (const path of ["/",homedir(),tmpdir(),join(root,"missing.ts")]) expect(await discovery.discover(root,path)).toBeUndefined();
    expect(accessedPaths("untrusted_tool",{path:root},root)).toEqual([]);
    expect(accessedPaths("read",{content:`read ${root}`},root)).toEqual([]);
  });
  it("coalesces and caches metadata probes, with no post-reset resurrection", async () => {
    const root=folder(); mkdirSync(join(root,".git")); const file=source(root), discovery=new ProjectDiscovery();
    const results=await Promise.all(Array.from({length:32},()=>discovery.discover(root,file)));
    expect(results.every(result=>result?.root===root)).toBe(true); expect(discovery.stats.walks).toBe(1);
    await discovery.discover(root,file); expect(discovery.stats.hits).toBeGreaterThan(0);
    const pending=discovery.discover(root,source(root,"fresh/b.ts")); discovery.clear();
    expect(await pending).toBeUndefined();
  });
});

describe("execution root ownership", () => {
  it("uses cwd-relative paths, longest enrolled ownership, and physical symlink boundaries", () => {
    const parent=folder(), a=join(parent,"a"), nested=join(a,"nested"), sibling=join(parent,"ab");
    mkdirSync(nested,{recursive:true}); mkdirSync(sibling);
    symlinkSync(nested,join(parent,"alias"),"dir"); symlinkSync(sibling,join(a,"escape"),"dir");
    const roots=new ExecutionRoots(); roots.bind(a); roots.bind(nested);
    expect(roots.target(parent,"alias")).toBe(nested); expect(roots.target(parent)).toBe(nested);
    expect(roots.owner(parent,"alias/new/deep.ts")).toEqual({root:nested,path:"new/deep.ts"});
    expect(roots.owner(parent,"a/new.ts")).toEqual({root:a,path:"new.ts"});
    expect(roots.owner(parent,"ab/file.ts")).toBeUndefined();
    expect(roots.owner(parent,"a/escape/new.ts")).toBeUndefined();
    expect(canonicalPath(parent,"alias")).toBe(nested);
    roots.clear(); expect(roots.list(parent)).toEqual([]); expect(roots.target(parent)).toBe(parent);
  });
});

describe("literal access hints", () => {
  it("supports structured paths, cwd, and literal cd/git -C without interpreting a shell", () => {
    const cwd="/work/launcher";
    expect(accessedPaths("read",{path:"../a/src/a.ts"},cwd)).toEqual(["../a/src/a.ts"]);
    expect(accessedPaths("bash",{command:"cd '/projects/space here' && git -C ../b status"},cwd)).toEqual(["/projects/space here","/projects/b"]);
    expect(accessedPaths("bash",{cwd:"/project/a",command:"git status"},cwd)).toEqual(["/project/a"]);
    expect(accessedPaths("bash",{command:"git -C ../a -C sub status"},cwd)).toEqual(["/work/a/sub"]);
  });
  it("refuses opaque scripts, expansions, comments, redirects and quoted fake commands", () => {
    for (const command of ['cd "$HOME/private" && ls','echo "cd /private"','echo "&& cd /private"','# comment && cd /private','cat <<EOF\ncd /private\nEOF','cd /a; cd /b','cd /a | cat','cd `pwd`','cd /a/*']) {
      expect(accessedPaths("bash",{command},"/work")).toEqual([]);
    }
  });
});
