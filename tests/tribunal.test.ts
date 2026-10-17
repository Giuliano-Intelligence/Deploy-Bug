import { test } from "node:test";
import assert from "node:assert";
process.env.DRY_RUN = "1"; process.env.DEPLOYBUG_SIGNING_KEY = "k"; process.env.VAULT_FILE = "/tmp/deploybug-tri-vault.json"; process.env.CHECKER_OFFLINE = "1"; process.env.GATE_OWNER_TOKEN = "owner-token-0123456789abcdef"; process.env.GATE_AGENT_TOKEN = "agent-token-0123456789abcdef"; process.env.REFUND_HISTORY_FILE = `/tmp/db-refunds-${process.pid}-${Math.random()}.json`;
const { AgentPool, ResultStore, tribunal, PROMPTS } = await import("@deploybug/workers");
const { buildGate } = await import("../apps/gate/src/app.ts");
const { TelegramNotifier } = await import("@deploybug/notifier");

const dir = () => `/tmp/db-tri-${process.pid}-${Math.random().toString(36).slice(2)}`;
type Script = Partial<Record<string, (input: string, n: number) => any>>;
function runner(script: Script) {
  const seen: { role: string; id: string; input: string }[] = []; const count: Record<string, number> = {};
  const fn = async (role: string, id: string, input: string) => { seen.push({ role, id, input }); count[role] = (count[role] ?? 0) + 1; return JSON.stringify(script[role]!(input, count[role])); };
  return { fn, seen, count };
}
const check = (v: string, r: string) => () => ({ verdict: v, reasoning: r });

test("every role has its own specific prompt", () => {
  for (const r of ["injection_checker", "rule_checker", "judge", "investigator", "auditor"]) assert.ok((PROMPTS as any)[r].length > 200);
});
test("exact match accepts fast without a judge, fresh id per step", async () => {
  const r = runner({ injection_checker: check("block", "same"), auditor: () => ({ ok: true, notes: "fine" }) });
  const out = await tribunal(new AgentPool(r.fn as any), new ResultStore(dir()), "injection", "x");
  assert.equal(out.path, "exact"); assert.equal(out.verdict, "block"); assert.equal(r.count.judge, undefined);
  assert.equal(new Set(r.seen.map(s => s.id)).size, r.seen.length);
});
test("similarity 90+ accepts", async () => {
  let i = 0;
  const r = runner({ rule_checker: () => ({ verdict: "allow", reasoning: `r${++i}` }), judge: () => ({ similarity: 95, verdict: "allow" }), auditor: () => ({ ok: true }) });
  const out = await tribunal(new AgentPool(r.fn as any), new ResultStore(dir()), "refund", "x");
  assert.equal(out.path, "similar"); assert.equal(out.verdict, "allow");
});
test("60-89 goes to the investigator, which can flag a compromised checker", async () => {
  let i = 0;
  const r = runner({ rule_checker: () => ({ verdict: ++i % 2 ? "allow" : "block", reasoning: `r${i}` }), judge: () => ({ similarity: 70 }), investigator: () => ({ compromised: "a", verdict: "block" }), auditor: () => ({ ok: true }) });
  const out = await tribunal(new AgentPool(r.fn as any), new ResultStore(dir()), "push", "x");
  assert.equal(out.path, "investigator"); assert.equal(out.verdict, "block"); assert.equal(out.ticket, true);
});
test("below 60 retries 5 times then blocks with a ticket", async () => {
  let i = 0;
  const r = runner({ rule_checker: () => ({ verdict: "allow", reasoning: `r${++i}` }), judge: () => ({ similarity: 20 }), auditor: () => ({ ok: true }) });
  const out = await tribunal(new AgentPool(r.fn as any), new ResultStore(dir()), "push", "x");
  assert.equal(out.path, "exhausted"); assert.equal(out.verdict, "block"); assert.equal(out.ticket, true); assert.equal(r.count.rule_checker, 10);
});
test("results persist on disk until the auditor discards them", async () => {
  const d = dir();
  const r1 = runner({ injection_checker: check("allow", "same"), auditor: () => ({ ok: false, notes: "check again" }) });
  const kept = await tribunal(new AgentPool(r1.fn as any), new ResultStore(d), "injection", "x");
  const reopened = new ResultStore(d);
  assert.equal(reopened.pending().length, 1); assert.ok(reopened.get(kept.runId).attempts[0].a.reasoning);
  const r2 = runner({ injection_checker: check("allow", "same"), auditor: () => ({ ok: true }) });
  const gone = await tribunal(new AgentPool(r2.fn as any), new ResultStore(d), "injection", "y");
  assert.equal(new ResultStore(d).get(gone.runId).discarded, true); assert.equal(new ResultStore(d).get(gone.runId).attempts, 1);
});
test("checkers are blind to each other", async () => {
  let i = 0;
  const r = runner({ rule_checker: () => ({ verdict: "allow", reasoning: `r${++i}` }), judge: () => ({ similarity: 99, verdict: "allow" }), auditor: () => ({ ok: true }) });
  await tribunal(new AgentPool(r.fn as any), new ResultStore(dir()), "refund", "subject");
  for (const s of r.seen.filter(s => s.role === "rule_checker")) assert.doesNotMatch(s.input, /CHECKER|r1|r2/);
});
test("sandbox per task stays off on the Free plan", () => {
  process.env.SANDBOX_PER_TASK = "1";
  assert.throws(() => new AgentPool((async () => "") as any));
  delete process.env.SANDBOX_PER_TASK;
});
test("confirmed hack on a live change rolls back without approval", async () => {
  const { signCommit } = await import("@deploybug/policy");
  const R = "Giuliano-Intelligence/Deploy-Bug";
  const files: Record<string, any[]> = { c3: [{ path: "a.ts", content: "bad" }], c2: [{ path: "a.ts", content: "good" }] };
  const msg = (s: string) => `x\n\nDeploy-Bug-Approved: t-${s}\nDeploy-Bug-Signature: ${signCommit("k", `t-${s}`, R, "main", files[s])}`;
  const source = { async commits() { return [{ sha: "c3", message: msg("c3") }, { sha: "c2", message: msg("c2") }]; }, async guardGreen() { return true; }, async changedPaths() { return ["a.ts"]; }, async fileAt(s: string) { return s === "c2" ? "good" : "bad"; }, async commitFiles(s: string) { return files[s]; } };
  const log: string[] = [];
  const ops = { async headOf() { return "c3"; }, async createBranch() {}, async commit() { return "c4"; }, async guardConclusion() { return "success" as const; }, async fastForward(b: string) { log.push(`ff ${b}`); }, async deleteBranch() {} };
  const r = runner({ injection_checker: check("block", "same"), auditor: () => ({ ok: true }) });
  const g = buildGate({ notifier: new TelegramNotifier(undefined), runner: r.fn as any, store: new ResultStore(dir()), rollback: { source, ops, wait: { tries: 2, ms: 1 } }, redeploy: async () => ({}) });
  const res = await g.app.request("/incident", { method: "POST", headers: { authorization: "Bearer owner-token-0123456789abcdef", "content-type": "application/json" }, body: JSON.stringify({ repo: "Giuliano-Intelligence/Deploy-Bug", evidence: "suspicious change in a.ts" }) });
  const j: any = await res.json();
  assert.equal(j.hacked, true); assert.equal(j.rolledBack, true); assert.deepEqual(log, ["ff main"]);
});
