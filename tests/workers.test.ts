import { test } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
process.env.DEPLOYBUG_AGENT_DIR = `/tmp/deploybug-agents-test-${process.pid}`;
process.env.CHECKER_OFFLINE = "1";
const { sanitizeProposals, remember, history, memoryDir, reviewPush } = await import("@deploybug/workers");
const { analysePush } = await import("../apps/gate/src/push.ts");
const { InjectionChecker, loadModels } = await import("@deploybug/checker");
const { InProcessQueue } = await import("@deploybug/queue");

test("agent proposals outside the gate actions are dropped", () => {
  const p = sanitizeProposals([{ op: "write_file", path: "a.ts" }, { op: "delete_file", path: "../x" }, { op: "delete_file", path: "dist/a.js" }, { op: "remove_dependency", path: "package.json", detail: "left-pad" }]);
  assert.deepEqual(p, [{ op: "delete_file", path: "dist/a.js" }, { op: "remove_dependency", path: "package.json", detail: "left-pad" }]);
});
test("per-app memory lives on the deepagents filesystem", () => {
  assert.ok(existsSync(`${memoryDir("stripe")}/AGENTS.md`));
  remember("stripe", "refund ch_1 ran");
  assert.match(history("stripe"), /refund ch_1 ran/);
  assert.doesNotMatch(history("github"), /refund ch_1/);
});
test("review is skipped without a model, so no process or agent is created", async () => {
  const r = await reviewPush(undefined, [{ path: "a.ts", content: "x" }], "m");
  assert.deepEqual(r.proposals, []);
});
test("policy enforces agent proposals: delete and dependency removal only", async () => {
  const pol = { repos: ["o/r"], branches: ["*"], protectedBranches: [] };
  const checker = new InjectionChecker(loadModels());
  const pkg = JSON.stringify({ name: "x", dependencies: { "left-pad": "1", hono: "4" } }, null, 2) + "\n";
  const a = await analysePush({ repo: "o/r", branch: "f", message: "m", files: [{ path: "dist/a.js", content: "x" }, { path: "package.json", content: pkg }] }, pol, checker, 0,
    [{ op: "delete_file", path: "dist/a.js" }, { op: "remove_dependency", path: "package.json", detail: "left-pad" }]);
  assert.equal(a.sanitized.find(f => f.path === "dist/a.js")!.content, null);
  assert.deepEqual(Object.keys(JSON.parse(a.sanitized.find(f => f.path === "package.json")!.content!).dependencies), ["hono"]);
  const b = await analysePush({ repo: "o/r", branch: "f", message: "m", files: [{ path: "a.ts", content: "x" }] }, pol, checker, 0, [{ op: "write_file", path: "a.ts" }]);
  assert.equal(b.verdict, "block");
});
test("queue runs at most 2 jobs at once", async () => {
  const q = new InProcessQueue(2); let live = 0, peak = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => q.add("j", async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 20)); live--; })));
  assert.equal(peak, 2);
});
