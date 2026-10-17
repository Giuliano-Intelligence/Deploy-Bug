import { test } from "node:test";
import assert from "node:assert";
process.env.DRY_RUN = "1"; process.env.VAULT_FILE = "/tmp/deploybug-media-vault.json"; process.env.CHECKER_OFFLINE = "1"; process.env.BUGFLIX_GATE_TOKEN = "bf-test"; process.env.GATE_OWNER_TOKEN = "owner-token-0123456789abcdef"; process.env.GATE_AGENT_TOKEN = "agent-token-0123456789abcdef"; process.env.REFUND_HISTORY_FILE = `/tmp/db-refunds-${process.pid}-${Math.random()}.json`;
const { MuxMedia } = await import("@deploybug/providers");
const { buildGate } = await import("../apps/gate/src/app.ts");
const { TelegramNotifier } = await import("@deploybug/notifier");

const assets = { data: [
  { id: "old", status: "ready", created_at: "100", playback_ids: [{ id: "p-old", policy: "public" }], meta: { title: "Old" } },
  { id: "new", status: "ready", created_at: "300", playback_ids: [{ id: "p-signed", policy: "signed" }, { id: "p-new", policy: "public" }], meta: { title: "Li Feng The Skyrider", description: "d" } },
  { id: "wip", status: "preparing", created_at: "400", playback_ids: [{ id: "p-wip", policy: "public" }] },
  { id: "priv", status: "ready", created_at: "500", playback_ids: [{ id: "p-priv", policy: "signed" }] } ] };
let calls = 0; let clock = 0;
const fake = (async (_u: string, init: any) => { calls++; assert.match(init.headers.authorization, /^Basic /); return new Response(JSON.stringify(assets)); }) as any;
const media = new MuxMedia({ fetch: fake, creds: () => ({ id: "i", secret: "s" }), now: () => clock });
const g = buildGate({ notifier: new TelegramNotifier(undefined), media });
const get = (h: Record<string, string> = {}) => g.app.request("/media/current", { headers: h });

test("latest ready asset with a public playback id", async () => {
  const r = await get({ authorization: "Bearer bf-test", origin: "https://bugflix.example" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { playbackId: "p-new", title: "Li Feng The Skyrider", description: "d" });
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});
test("needs the gate token", async () => {
  assert.equal((await get()).status, 401);
  assert.equal((await get({ authorization: "Bearer nope" })).status, 401);
});
test("cached for 60 seconds", async () => {
  const before = calls;
  clock = 30_000; await get({ authorization: "Bearer bf-test" }); assert.equal(calls, before);
  clock = 61_000; await get({ authorization: "Bearer bf-test" }); assert.equal(calls, before + 1);
});
test("CORS preflight is answered without the token", async () => {
  const r = await g.app.request("/media/current", { method: "OPTIONS", headers: { origin: "https://x.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});
test("works in dry run and fails closed without credentials", async () => {
  const m = new MuxMedia({ fetch: fake, creds: () => ({}) });
  await assert.rejects(() => m.current());
});
