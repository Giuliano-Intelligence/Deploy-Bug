import { test } from "node:test";
import assert from "node:assert";
import { createHash, createHmac } from "node:crypto";
const { stagedPush, stageBranch, composioStageOps } = await import("../apps/gate/src/stage.ts");

function fakeOps(conclusion: "success" | "failure") {
  const log: string[] = []; const msgs: string[] = []; let n = 0;
  return { log, msgs, ops: {
    async headOf(b: string) { log.push(`head ${b}`); return "base"; },
    async createBranch(b: string, s: string) { log.push(`create ${b} ${s}`); },
    async commit(b: string, files: any[], m: string) { msgs.push(m); log.push(`commit ${b} ${files.length}`); return `c${++n}`; },
    async guardConclusion(s: string) { log.push(`guard ${s}`); return conclusion; },
    async fastForward(b: string, s: string) { log.push(`ff ${b} ${s}`); },
    async deleteBranch(b: string) { log.push(`delete ${b}`); },
  } };
}
const p = { repo: "o/r", target: "main", ticket: "t1", message: "m", key: "k", files: [{ path: "a.ts", content: "x" }, { path: "b.ts", content: null }] };
const fast = { tries: 3, ms: 1 };

test("green guard stages, fast-forwards main and deletes the stage", async () => {
  const f = fakeOps("success");
  const r = await stagedPush(f.ops, p, fast);
  assert.equal(r.pushed, true);
  assert.deepEqual(f.log, ["head main", `create ${stageBranch("main", "t1")} base`, `commit ${stageBranch("main", "t1")} 2`, "guard c1", "ff main c1", `delete ${stageBranch("main", "t1")}`]);
});
test("red guard never touches main", async () => {
  const f = fakeOps("failure");
  const r = await stagedPush(f.ops, p, fast);
  assert.equal(r.pushed, false);
  assert.ok(!f.log.some(l => l.startsWith("ff")));
});
test("per-file commits are each signed over their own file, bound to the target branch", async () => {
  const f = fakeOps("success");
  await stagedPush(f.ops, { ...p, perFile: true }, fast);
  assert.equal(f.msgs.length, 2);
  const digest = createHash("sha256").update(`a.ts\0${createHash("sha256").update("x").digest("hex")}`).digest("hex");
  const sig = createHmac("sha256", "k").update(`t1:o/r:main:${digest}`).digest("hex");
  assert.match(f.msgs[0], new RegExp(`Deploy-Bug-Approved: t1\\nDeploy-Bug-Signature: ${sig}$`));
});
test("composio ops use refs and never force", async () => {
  const calls: [string, any][] = [];
  const ops = composioStageOps(async (t, a) => { calls.push([t, a]); if (t === "GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY") return { data: { workflow_runs: [{ name: "deploybug-guard", path: ".github/workflows/deploybug-guard.yml", status: "completed", conclusion: "success" }] } }; return { data: { commit: { sha: "s9" } } }; }, "o/r");
  const r = await stagedPush(ops, { ...p, perFile: true }, fast);
  assert.equal(r.pushed, true);
  assert.deepEqual(calls.map(c => c[0]).filter(t => t.includes("REFERENCE")), ["GITHUB_CREATE_A_REFERENCE", "GITHUB_UPDATE_A_REFERENCE", "GITHUB_DELETE_A_REFERENCE"]);
  assert.equal(calls.find(c => c[0] === "GITHUB_UPDATE_A_REFERENCE")![1].force, false);
});
