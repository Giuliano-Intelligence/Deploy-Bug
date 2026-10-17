import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync } from "node:fs";
process.env.DRY_RUN = "1"; process.env.VAULT_FILE = "/tmp/deploybug-vpn-vault.json"; process.env.CHECKER_OFFLINE = "1"; process.env.GATE_AGENT_TOKEN = "gt";
const { VpnMode, inCidr } = await import("../apps/gate/src/vpn.ts");
const { buildGate } = await import("../apps/gate/src/app.ts");
const { TelegramNotifier } = await import("@deploybug/notifier");

const d = `/tmp/db-vpn-${process.pid}`;
const conf = `${d}-peer.conf`;
let ip = "203.0.113.9";
const vpn = new VpnMode({ file: `${d}/vpn.json`, configFile: conf, cidrs: ["10.8.0.0/24"], ipOf: () => ip });
const g = buildGate({ notifier: new TelegramNotifier(undefined), vpn });
const h = { authorization: "Bearer gt", "content-type": "application/json" };

test("cidr matching", () => {
  assert.ok(inCidr("10.8.0.5", "10.8.0.0/24")); assert.ok(inCidr("::ffff:10.8.0.5", "10.8.0.0/24")); assert.ok(!inCidr("10.9.0.5", "10.8.0.0/24"));
});
test("off by default, public gate works", async () => {
  assert.equal(vpn.enabled, false);
  assert.equal((await g.app.request("/workers")).status, 200);
});
test("cannot enable without a peer config, to avoid a lockout", async () => {
  assert.equal((await g.app.request("/vpn", { method: "POST", headers: h, body: JSON.stringify({ enabled: true }) })).status, 409);
});
test("enable restricts to VPN addresses, disable restores public access", async () => {
  writeFileSync(conf, "[Interface]\nPrivateKey = test\nAddress = 10.8.0.2/32\n\n[Peer]\nPublicKey = test\nEndpoint = vpn.example:51820\nAllowedIPs = 10.8.0.0/24\n");
  const qr = await g.app.request("/vpn/config?format=qr", { headers: h });
  assert.equal(qr.headers.get("content-type"), "image/svg+xml"); assert.match(await qr.text(), /<svg/);
  assert.equal((await g.app.request("/vpn", { method: "POST", headers: h, body: JSON.stringify({ enabled: true }) })).status, 200);
  assert.equal((await g.app.request("/workers")).status, 403);
  assert.equal((await g.app.request("/health")).status, 200);
  assert.equal((await g.app.request("/workers", { headers: { "x-forwarded-for": "10.8.0.2" } })).status, 403);
  ip = "10.8.0.2";
  assert.equal((await g.app.request("/workers")).status, 200);
  assert.equal((await g.app.request("/vpn", { method: "POST", headers: h, body: JSON.stringify({ enabled: false }) })).status, 200);
  ip = "203.0.113.9";
  assert.equal((await g.app.request("/workers")).status, 200);
});
test("VPN_FORCE_OFF is the break-glass switch", () => {
  vpn.set(true); process.env.VPN_FORCE_OFF = "1";
  assert.equal(vpn.enabled, false);
  delete process.env.VPN_FORCE_OFF; vpn.set(false);
});
