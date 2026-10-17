import { test } from "node:test";
import assert from "node:assert";
process.env.DRY_RUN = "1"; process.env.VAULT_FILE = "/tmp/deploybug-rb-vault.json"; process.env.CHECKER_OFFLINE = "1"; process.env.GATE_AGENT_TOKEN = "gt";
const { planRollback, runRollback } = await import("../apps/gate/src/rollback.ts");
const { GateActionGuard } = await import("@deploybug/policy");
const { buildGate } = await import("../apps/gate/src/app.ts");
const { TelegramNotifier } = await import("@deploybug/notifier");

const sig = "\n\nDeploy-Bug-Approved: t1\nDeploy-Bug-Signature: " + "a".repeat(64);
const tree: Record<string, Record<string, string | null>> = {
  c3: { "a.ts": "bad", "new.ts": "added" },
  c2: { "a.ts": "good", "new.ts": null },
};
const src = (green = new Set(["c2"])) => ({
  async commits() { return [{ sha: "c3", message: "Bad" + sig }, { sha: "c2", message: "Good" + sig }, { sha: "c1", message: "unsigned" }]; },
  async guardGreen(s: string) { return green.has(s); },
  async changedPaths() { return ["a.ts", "new.ts"]; },
  async fileAt(s: string, p: string) { return tree[s]?.[p] ?? null; },
});
function ops() {
  const log: string[] = []; let files: any[] = []; let message = "";
  return { log, get files() { return files; }, get message() { return message; }, o: {
    async headOf() { return "c3"; }, async createBranch(b: string) { log.push(`create ${b}`); },
    async commit(_b: string, f: any[], m: string) { files = f; message = m; return "c4"; },
    async guardConclusion() { return "success" as const; },
    async fastForward(b: string, s: string) { log.push(`ff ${b} ${s}`); }, async deleteBranch(b: string) { log.push(`delete ${b}`); },
  } };
}

test("rollback restores the last signed green commit's files", async () => {
  const p = await planRollback(src(), "main");
  assert.equal(p.good, "c2");
  assert.deepEqual(p.files, [{ path: "a.ts", content: "good" }, { path: "new.ts", content: null }]);
  assert.ok(p.changes.every(c => c.op === "restore"));
});
test("unsigned or red commits are never rollback targets", async () => {
  await assert.rejects(() => planRollback(src(new Set()), "main"), /no earlier gate-signed/);
  await assert.rejects(() => planRollback(src(), "main", "c1"), /not a gate-signed/);
});
test("restore guard rejects anything that is not the prior signed content", () => {
  const g = new GateActionGuard();
  assert.equal(g.verify({ op: "restore", path: "a.ts", detail: "c2" }, { path: "a.ts", content: "bad" }, { path: "a.ts", content: "good" }, { path: "a.ts", content: "good" }), undefined);
  assert.match(g.verify({ op: "restore", path: "a.ts", detail: "c2" }, { path: "a.ts", content: "bad" }, { path: "a.ts", content: "new code" }, { path: "a.ts", content: "good" })!, /does not match/);
  assert.match(g.verify({ op: "restore", path: "a.ts" }, { path: "a.ts", content: "x" }, { path: "a.ts", content: "x" })!, /needs the signed commit/);
});
test("rollback goes through the staged signed flow, never force, then redeploys", async () => {
  const k = ops(); let deployed = 0;
  const r = await runRollback(src(), k.o, { repo: "o/r", branch: "main", ticket: "rb1", key: "k" }, async () => { deployed++; }, { tries: 2, ms: 1 });
  assert.equal(r.pushed, true); assert.equal(deployed, 1);
  assert.match(k.message, /^Revert main to c2/);
  assert.match(k.message, /Deploy-Bug-Approved: rb1\nDeploy-Bug-Signature: [0-9a-f]{64}$/);
  assert.ok(k.log.includes("ff main c4"));
});
test("rollback endpoint needs owner approval before anything runs", async () => {
  const k = ops(); let deployed = 0;
  const g = buildGate({ notifier: new TelegramNotifier(undefined), rollback: { source: src(), ops: k.o, wait: { tries: 2, ms: 1 } }, redeploy: async () => { deployed++; return {}; } });
  const h = { authorization: "Bearer gt", "content-type": "application/json" };
  const r = await g.app.request("/rollback", { method: "POST", headers: h, body: JSON.stringify({ repo: "Giuliano-Intelligence/Deploy-Bug", reason: "player broke" }) });
  assert.equal(r.status, 202);
  const j: any = await r.json();
  assert.equal(k.log.length, 0);
  const d: any = await g.decide(j.ticket, true);
  assert.equal(d.status, "executed"); assert.equal(d.result.pushed, true); assert.equal(deployed, 1);
  assert.equal((await g.app.request("/rollback", { method: "POST", headers: h, body: JSON.stringify({ repo: "someone/else" }) })).status, 403);
  assert.equal((await g.app.request("/rollback", { method: "POST", body: "{}" })).status, 401);
});
