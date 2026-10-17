import { test } from "node:test";
import assert from "node:assert";
process.env.DRY_RUN = "1"; process.env.DEPLOYBUG_SIGNING_KEY = "k"; process.env.VAULT_FILE = "/tmp/deploybug-rb-vault.json"; process.env.CHECKER_OFFLINE = "1"; process.env.GATE_OWNER_TOKEN = "owner-token-0123456789abcdef"; process.env.GATE_AGENT_TOKEN = "agent-token-0123456789abcdef"; process.env.REFUND_HISTORY_FILE = `/tmp/db-refunds-${process.pid}-${Math.random()}.json`;
const { planRollback, runRollback } = await import("../apps/gate/src/rollback.ts");
const { GateActionGuard, signCommit } = await import("@deploybug/policy");
const { hmacVerifier } = await import("../apps/gate/src/rollback.ts");
const { buildGate } = await import("../apps/gate/src/app.ts");
const { TelegramNotifier } = await import("@deploybug/notifier");

const tree: Record<string, Record<string, string | null>> = {
  c3: { "a.ts": "bad", "new.ts": "added" },
  c2: { "a.ts": "good", "new.ts": null },
  c1: { "a.ts": "first", "new.ts": null },
};
const own: Record<string, { path: string; content: string | null }[]> = { c3: [{ path: "a.ts", content: "bad" }, { path: "new.ts", content: "added" }], c2: [{ path: "a.ts", content: "good" }], c1: [{ path: "a.ts", content: "first" }] };
const signed = (sha: string, repo: string, key = "k") => `m\n\nDeploy-Bug-Approved: t-${sha}\nDeploy-Bug-Signature: ${signCommit(key, `t-${sha}`, repo, "main", own[sha])}`;
const src = (green = new Set(["c2", "c1"]), repo = "o/r", forged = false) => ({
  async commits() { return [{ sha: "c3", message: signed("c3", repo) }, { sha: "c2", message: forged ? signed("c2", repo, "attacker") : signed("c2", repo) }, { sha: "c1", message: "unsigned" }]; },
  async guardGreen(s: string) { return green.has(s); },
  async changedPaths() { return ["a.ts", "new.ts"]; },
  async fileAt(s: string, p: string) { return tree[s]?.[p] ?? null; },
  async commitFiles(s: string) { return own[s]; },
});
const V = (x: any, repo = "o/r") => hmacVerifier(x, "k", repo, "main");
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
  const x = src(); const p = await planRollback(x, "main", undefined, V(x));
  assert.equal(p.good, "c2");
  assert.deepEqual(p.files, [{ path: "a.ts", content: "good" }, { path: "new.ts", content: null }]);
  assert.ok(p.changes.every(c => c.op === "restore"));
});
test("unsigned or red commits are never rollback targets", async () => {
  const a = src(new Set()), b = src(), f = src(undefined, "o/r", true);
  await assert.rejects(() => planRollback(a, "main", undefined, V(a)), /no earlier gate-signed/);
  await assert.rejects(() => planRollback(b, "main", "c1", V(b)), /not a gate-signed/);
  await assert.rejects(() => planRollback(f, "main", undefined, V(f)), /no earlier gate-signed/);
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
  const g = buildGate({ notifier: new TelegramNotifier(undefined), rollback: { source: src(undefined, "Giuliano-Intelligence/Deploy-Bug"), ops: k.o, wait: { tries: 2, ms: 1 } }, redeploy: async () => { deployed++; return {}; } });
  const h = { authorization: "Bearer agent-token-0123456789abcdef", "content-type": "application/json" };
  const r = await g.app.request("/rollback", { method: "POST", headers: h, body: JSON.stringify({ repo: "Giuliano-Intelligence/Deploy-Bug", reason: "player broke" }) });
  assert.equal(r.status, 202);
  const j: any = await r.json();
  assert.equal(k.log.length, 0);
  const d: any = await g.decide(j.ticket, true);
  assert.equal(d.status, "executed"); assert.equal(d.result.pushed, true); assert.equal(deployed, 1);
  assert.equal((await g.app.request("/rollback", { method: "POST", headers: h, body: JSON.stringify({ repo: "someone/else" }) })).status, 403);
  assert.equal((await g.app.request("/rollback", { method: "POST", body: "{}" })).status, 401);
});
