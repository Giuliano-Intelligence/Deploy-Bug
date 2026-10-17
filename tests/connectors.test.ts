import { test } from "node:test";
import assert from "node:assert";
process.env.DRY_RUN = "1"; process.env.VAULT_FILE = "/tmp/deploybug-conn-vault.json"; process.env.CHECKER_OFFLINE = "1";
process.env.GATE_OWNER_TOKEN = "owner-token-0123456789abcdef"; process.env.GATE_AGENT_TOKEN = "agent-token-0123456789abcdef"; process.env.REFUND_HISTORY_FILE = `/tmp/db-conn-${process.pid}.json`;
const { CONNECTORS, ToolkitAgents, AgentPool } = await import("@deploybug/workers");
const { buildGate } = await import("../apps/gate/src/app.ts");
const { TelegramNotifier } = await import("@deploybug/notifier");
const O = { authorization: "Bearer owner-token-0123456789abcdef", accept: "application/json" };

test("catalog has the builder tools, Aikido and Expo as custom MCP", () => {
  const s = CONNECTORS.map(c => c.slug);
  for (const k of ["github", "supabase", "neon", "clerk", "aws", "cloudflare", "stripe", "sentry", "mux", "aikido"]) assert.ok(s.includes(k), k);
  assert.ok(s.includes("vercel")); assert.equal(CONNECTORS.find(c => c.slug === "expo")!.via, "custom_mcp");
  assert.equal(CONNECTORS.find(c => c.slug === "aikido")!.via, "custom_mcp");
});
test("connect sends only Composio toolkits to Composio", async () => {
  let sent: string[] = [];
  const g = buildGate({ notifier: new TelegramNotifier(undefined), connect: async tk => { sent = tk; return Object.fromEntries(tk.map(t => [t, { status: "initiated", redirect_url: `https://connect.composio.dev/link/lk_${t}` }])); } });
  const r: any = await (await g.app.request("/connect?toolkits=supabase,aikido,nope", { headers: O })).json();
  assert.deepEqual(sent, ["supabase"]);
  assert.deepEqual(r.links.map((l: any) => [l.toolkit, l.status]), [["supabase", "initiated"], ["aikido", "needs_setup"], ["nope", "not_in_catalog"]]);
  assert.match(await (await g.app.request("/connect", { headers: { authorization: O.authorization } })).text(), /Neon/);
});
test("events go to a fresh pool agent per step", async () => {
  process.env.DRY_RUN = "0";
  const ids: string[] = [];
  const pool = new AgentPool(async (role, id) => { ids.push(`${role}:${id}`); return "summary"; });
  const t = new ToolkitAgents(() => undefined, () => pool);
  t.sync({ neon: 1 });
  const a: any = await t.handle({ type: "NEON_BRANCH_CREATED" }); const b: any = await t.handle({ type: "NEON_BRANCH_CREATED" });
  assert.notEqual(a.agent, b.agent); assert.ok(ids.every(i => i.startsWith("tool_worker:")));
  process.env.DRY_RUN = "1";
});
