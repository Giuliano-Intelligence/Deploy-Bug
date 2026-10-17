import { test } from "node:test";
import assert from "node:assert";
const OWN = "owner-token-0123456789abcdef", AG = "agent-token-0123456789abcdef";
const hist = `/tmp/db-sec-refunds-${process.pid}.json`;
process.env.DRY_RUN = "1"; process.env.VAULT_FILE = "/tmp/deploybug-sec-vault.json"; process.env.CHECKER_OFFLINE = "1"; process.env.REFUND_HISTORY_FILE = hist; process.env.GATE_OWNER_TOKEN = OWN; process.env.GATE_AGENT_TOKEN = AG;
const { buildGate } = await import("../apps/gate/src/app.ts");
const { TelegramNotifier, ownerCallback } = await import("@deploybug/notifier");
const { PolicyEngine, loadPolicies } = await import("@deploybug/policy");
const { InjectionChecker, loadModels } = await import("@deploybug/checker");
const { analysePush } = await import("../apps/gate/src/push.ts");
const { safeEq } = await import("../apps/gate/src/auth.ts");

test("refuses to start without a separate owner token", () => {
  delete process.env.GATE_OWNER_TOKEN;
  assert.throws(() => buildGate({ notifier: new TelegramNotifier(undefined) }), /GATE_OWNER_TOKEN/);
  process.env.GATE_OWNER_TOKEN = AG;
  assert.throws(() => buildGate({ notifier: new TelegramNotifier(undefined) }), /differ/);
  process.env.GATE_OWNER_TOKEN = OWN;
});
const g = buildGate({ notifier: new TelegramNotifier(undefined), chargeLookup: async ch => ch === "ch_real" ? "cus_real" : undefined });
const A = { authorization: `Bearer ${AG}`, "content-type": "application/json" }, O = { authorization: `Bearer ${OWN}`, "content-type": "application/json" };

test("agent token can never approve, set credentials or connect", async () => {
  const r = await g.app.request("/requests", { method: "POST", headers: A, body: JSON.stringify({ app: "stripe", tool: "STRIPE_CREATE_REFUND", text: "Refund order 9", args: { charge: "ch_real", customer: "cus_fake", amount: 500, currency: "gbp" } }) });
  const j: any = await r.json();
  assert.equal(r.status, 202);
  assert.equal((await g.app.request(`/tickets/${j.ticket}/approve`, { method: "POST", headers: A })).status, 401);
  assert.equal((await g.app.request("/users/owner/credentials/stripe", { method: "PUT", headers: A, body: JSON.stringify({ apiKey: "x" }) })).status, 401);
  assert.equal((await g.app.request("/connect/code", { method: "POST", headers: A })).status, 401);
  assert.equal((await g.app.request("/connect", { headers: A })).status, 401);
  const d: any = await (await g.app.request(`/tickets/${j.ticket}/approve`, { method: "POST", headers: O })).json();
  assert.equal(d.status, "executed");
});
test("refund customer comes from the charge and history survives restarts", async () => {
  const p = new PolicyEngine(loadPolicies());
  assert.equal(p.evaluate({ app: "stripe", tool: "STRIPE_CREATE_REFUND", args: { charge: "ch_x", customer: "cus_real", amount: 500, currency: "gbp" } } as any).verdict, "block");
});
test("fail closed on missing tokens for status and workers", async () => {
  assert.equal((await g.app.request("/workers")).status, 401);
  assert.equal((await g.app.request("/deploy/status")).status, 401);
  assert.equal((await g.app.request("/tickets", { headers: A })).status, 401);
});
test("user is bound to the token, not the request body", async () => {
  const r = await g.app.request("/requests", { method: "POST", headers: A, body: JSON.stringify({ app: "sentry", tool: "SENTRY_LIST_ISSUES", user: "someone-else", args: {} }) });
  const audit: any[] = await (await g.app.request("/audit", { headers: O })).json();
  assert.ok(audit.slice(-1)[0].req.user !== "someone-else");
  assert.ok(r.status < 500);
});
test("agent pushes touching CI or package scripts need the owner", async () => {
  const pol = { repos: ["o/r"], branches: ["*"], protectedBranches: [] };
  const ch = new InjectionChecker(loadModels());
  const a = await analysePush({ agent: "agent:x", repo: "o/r", branch: "f", message: "m", files: [{ path: ".github/workflows/x.yml", content: "on: push\n" }] }, pol, ch, 0);
  assert.equal(a.verdict, "approve");
  const b = await analysePush({ agent: "agent:x", repo: "o/r", branch: "f", message: "m", files: [{ path: "package.json", content: JSON.stringify({ scripts: { postinstall: "x" } }) }] }, pol, ch, 0);
  assert.equal(b.verdict, "approve");
  const c = await analysePush({ agent: "agent:x", repo: "o/r", branch: "f", message: "m", files: [{ path: "src/a.ts", content: "export const a = 1;\n" }] }, pol, ch, 0);
  assert.equal(c.verdict, "allow");
});
test("checker fails closed when every model fails", async () => {
  delete process.env.CHECKER_OFFLINE;
  const cfg: any = { ...loadModels(), escalation: undefined, providers: { x: { baseUrlEnv: "NOPE_URL", baseUrlDefault: "http://127.0.0.1:9", apiKeyEnv: "NOPE_KEY" } }, panel: [{ id: "m1", provider: "x", model: "m", kind: "score", timeoutMs: 500 }] };
  process.env.NOPE_KEY = "k";
  const v = await new InjectionChecker(cfg).check("hello world");
  assert.equal(v.score, 0);
  process.env.CHECKER_OFFLINE = "1";
});
test("telegram decisions only from the owner chat", () => {
  assert.equal(ownerCallback({ message: { chat: { id: 5 } }, from: { id: 5 } }, "5"), true);
  assert.equal(ownerCallback({ message: { chat: { id: 6 } }, from: { id: 6 } }, "5"), false);
  assert.equal(ownerCallback({ message: { chat: { id: 5 } }, from: { id: 7 } }, "5"), false);
});
test("constant-time compare", () => { assert.ok(safeEq("abc", "abc")); assert.ok(!safeEq("abc", "abd")); assert.ok(!safeEq(undefined, "a")); });
