import { test } from "node:test";
import assert from "node:assert";
import { generateKeyPairSync, createVerify } from "node:crypto";
process.env.DRY_RUN = "1"; process.env.VAULT_FILE = "/tmp/deploybug-cons-vault.json"; process.env.CHECKER_OFFLINE = "1"; process.env.GATE_AGENT_TOKEN = "gt";
const { consensus, ToolkitAgents } = await import("@deploybug/workers");
const { appJwt } = await import("@deploybug/providers");
const { appStageOps, stagedPush } = await import("../apps/gate/src/stage.ts");
const { buildGate } = await import("../apps/gate/src/app.ts");
const { TelegramNotifier } = await import("@deploybug/notifier");

const vote = (v: "allow" | "block") => async () => ({ verdict: v, reasoning: v });
const judgeOk = async (_k: string, _s: string, a: any) => ({ match: true, verdict: a.verdict, why: "same" });

test("agreeing checkers confirmed by the decision model", async () => {
  const r = await consensus("push", "x", [vote("allow"), vote("allow")], judgeOk);
  assert.equal(r.verdict, "allow"); assert.equal(r.attempts, 1); assert.equal(r.ticket, false);
});
test("mismatch retries up to 5 times then blocks with a ticket", async () => {
  let n = 0;
  const r = await consensus("refund", "x", [async () => { n++; return { verdict: "allow", reasoning: "" }; }, vote("block")], judgeOk);
  assert.equal(n, 5); assert.equal(r.verdict, "block"); assert.equal(r.ticket, true);
});
test("judge rejecting the match counts as a mismatch", async () => {
  const r = await consensus("push", "x", [vote("allow"), vote("allow")], async () => ({ match: false, verdict: "allow", why: "reasons differ" }));
  assert.equal(r.verdict, "block"); assert.equal(r.ticket, true);
});
test("recovers when a later attempt agrees", async () => {
  let i = 0;
  const r = await consensus("injection", "x", [async () => ({ verdict: ++i < 3 ? "allow" : "block", reasoning: "" }), vote("block")], judgeOk);
  assert.equal(r.verdict, "block"); assert.equal(r.agreed, true); assert.equal(r.attempts, 3);
});
test("voters run with separate inputs only", async () => {
  const seen: string[][] = [];
  await consensus("push", "subject", [async (k, s) => { seen.push([k, s]); return { verdict: "allow", reasoning: "" }; }, async (k, s) => { seen.push([k, s]); return { verdict: "allow", reasoning: "" }; }], judgeOk);
  assert.deepEqual(seen, [["push", "subject"], ["push", "subject"]]);
});

const blockAll = { voters: [vote("block"), vote("block")] as any, judge: judgeOk };
const g = buildGate({ notifier: new TelegramNotifier(undefined), consensus: blockAll, connect: async tk => Object.fromEntries(tk.map(t => [t, { status: "initiated", redirect_url: `https://connect.composio.dev/link/lk_${t}` }])) });
const auth = { authorization: "Bearer gt", "content-type": "application/json" };

test("refund requests go through the consensus panel and policy still applies", async () => {
  const r = await g.app.request("/requests", { method: "POST", headers: auth, body: JSON.stringify({ app: "stripe", tool: "STRIPE_CREATE_REFUND", text: "Refund order 7", args: { charge: "ch_7", customer: "cus_7", amount: 500, currency: "gbp" } }) });
  assert.equal(r.status, 403);
  assert.match((await r.json() as any).reason, /independent checkers/);
});
test("one-tap connect returns a Composio link per picked toolkit", async () => {
  const r = await g.app.request("/connect?t=gt&toolkits=github,stripe", { headers: { accept: "application/json" } });
  assert.deepEqual((await r.json() as any).links.map((l: any) => l.toolkit), ["github", "stripe"]);
  assert.equal((await g.app.request("/connect?toolkits=github")).status, 401);
  assert.match(await (await g.app.request("/connect?t=gt")).text(), /checkbox/);
});
test("each connected toolkit gets its own agent and events route to it", async () => {
  const s = await g.app.request("/connect/sync", { method: "POST", headers: auth, body: JSON.stringify({ sentry: 1, stripe: 1, slack: 0 }) });
  assert.deepEqual((await s.json() as any).agents, ["sentry-agent", "stripe-agent"]);
  const e = await g.app.request("/composio/events", { method: "POST", headers: auth, body: JSON.stringify({ type: "SENTRY_NEW_ISSUE", data: { title: "TypeError in player" } }) });
  assert.equal((await e.json() as any).agent, "sentry-agent");
  const u = await g.app.request("/composio/events", { method: "POST", headers: auth, body: JSON.stringify({ type: "NOTION_PAGE" }) });
  assert.equal((await u.json() as any).routed, false);
});
test("toolkit agents are created lazily, none when nothing is connected", () => assert.deepEqual(new ToolkitAgents(() => undefined).list(), []));

test("GitHub App JWT is RS256 signed with the app id", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = appJwt({ appId: "123", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() }, 1000);
  const [h, b, sig] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(b, "base64url").toString()).iss, "123");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig, "base64url")));
});
test("app stage ops make one signed commit and never force", async () => {
  const calls: [string, any][] = [];
  const api = async (path: string, init: any = {}) => {
    calls.push([`${init.method ?? "GET"} ${path}`, init.body && JSON.parse(init.body)]);
    if (path.startsWith("/git/ref/")) return { object: { sha: "p1" } };
    if (path.startsWith("/git/commits/")) return { tree: { sha: "t0" } };
    if (path === "/git/trees") return { sha: "t1" };
    if (path === "/git/commits") return { sha: "c1" };
    if (path.startsWith("/actions/runs")) return { workflow_runs: [{ name: "deploybug-guard", status: "completed", conclusion: "success" }] };
    return {};
  };
  const r = await stagedPush(appStageOps(api), { repo: "o/r", target: "main", ticket: "t9", message: "m", key: "k", files: [{ path: "a.ts", content: "x" }, { path: "b.ts", content: null }] }, { tries: 2, ms: 1 });
  assert.equal(r.pushed, true);
  assert.equal(calls.filter(c => c[0] === "POST /git/commits").length, 1);
  assert.match(calls.find(c => c[0] === "POST /git/commits")![1].message, /Deploy-Bug-Approved: t9/);
  assert.ok(calls.filter(c => c[0].startsWith("PATCH")).every(c => c[1].force === false));
  assert.ok(calls.some(c => c[0] === "PATCH /git/refs/heads/main"));
});
