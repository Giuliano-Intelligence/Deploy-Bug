import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runRollback, appRollbackSource, type RollbackSource } from "./rollback.ts";
import { execFile } from "node:child_process";
import { VpnMode } from "./vpn.ts";
import { DASHBOARD, MANIFEST, ICON } from "./ui.ts";
import { randomBytes } from "node:crypto";
import { GateStore, RateLimiter } from "./persist.ts";
import { gateTokens, principal, isOwner, isAgentOrOwner, OneTimeCodes, safeEq } from "./auth.ts";
import { stagedPush, composioStageOps, appStageOps, type StageOps, stageBranch, signedMessage } from "./stage.ts";
import { ComposioConnectMcp, MuxMedia, GitHubAppClient, appConfig } from "@deploybug/providers";
import { cors } from "hono/cors";
import { ingestComment } from "./ingest.ts";
import { analysePush, pushTicketText, type PushRequest } from "./push.ts";
import { randomUUID } from "node:crypto";
import { PolicyEngine, loadPolicies, type ActionRequest } from "@deploybug/policy";
import { InjectionChecker, loadModels } from "@deploybug/checker";
import { providerRegistry } from "@deploybug/providers";
import { WorkerFactory, reviewPush, AgentPool, ResultStore, tribunal, deepagentRunner, type StepRunner, ToolkitAgents, KNOWN_TOOLKITS, CONNECTORS, type Voter, type Judge } from "@deploybug/workers";
import { resolveProvider } from "@deploybug/checker";
import { FileVault, ProfileStore, type CredentialStore } from "@deploybug/vault";
import { factsFromRequest, summarizeTicket, templateAlert, formatTime } from "@deploybug/summarizer";
import { createQueue } from "@deploybug/queue";
import { TelegramNotifier, type Ticket } from "@deploybug/notifier";

export function buildGate(opts: { notifier?: TelegramNotifier; vault?: CredentialStore; media?: MuxMedia; runner?: StepRunner; store?: ResultStore; connect?: (toolkits: string[]) => Promise<Record<string, any>>; rollback?: { source: RollbackSource; ops: StageOps; wait?: { tries: number; ms: number } }; redeploy?: (repo: string) => Promise<unknown>; vpn?: VpnMode; chargeLookup?: (charge: string, user?: string) => Promise<string | undefined>; gateStore?: GateStore; rateLimiter?: RateLimiter } = {}) {
  const vpn = opts.vpn ?? new VpnMode();
  gateTokens();
  const codes = new OneTimeCodes();
  const media = opts.media ?? new MuxMedia();
  const vault = opts.vault ?? new FileVault();
  const profiles = new ProfileStore();
  const tzOf = (user?: string) => profiles.get(user ?? process.env.OWNER_USER ?? "owner").timezone;
  const models = loadModels();
  const policy = new PolicyEngine(loadPolicies());
  const checker = new InjectionChecker(models);
  const workers = new WorkerFactory(providerRegistry(), models);
  for (const [app, p] of Object.entries(policy.policies.apps)) workers.register(app, p);
  const notifier = opts.notifier ?? new TelegramNotifier();
  const queue = createQueue();
  const gstore = opts.gateStore ?? new GateStore();
  const tickets = new Map<string, Ticket>(gstore.loadTickets<Ticket>());
  const audit: any[] = gstore.loadAudit();
  const log = (e: any) => { const rec = { at: new Date().toISOString(), ...e }; audit.push(rec); if (audit.length > 500) audit.shift(); try { gstore.appendAudit(rec); gstore.saveTickets(tickets); } catch {} };

  async function execute(req: ActionRequest) {
    const w = workers.get(req.app)!;
    const user = req.user ?? "owner";
    const p = policy.app(req.app)!.provider;
    const credentials = await vault.get(user, p);
    const result = await queue.add(`${req.app}:${req.tool}`, () => w.run({ tool: req.tool, args: req.args, instruction: req.text, user, credentials }));
    policy.recordExecuted(req);
    return result;
  }

  function signingKey() {
    if (process.env.DEPLOYBUG_SIGNING_KEY) return process.env.DEPLOYBUG_SIGNING_KEY;
    const f = process.env.DEPLOYBUG_SIGNING_KEY_FILE ?? "/tmp/keys/deploybug_signing";
    if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, randomUUID() + randomUUID(), { mode: 0o600 }); }
    return readFileSync(f, "utf8").trim();
  }

  async function runPush(p: { req: PushRequest; files: { path: string; content: string | null }[]; ticket: string }) {
    const { req, files, ticket } = p;
    const user = req.user ?? process.env.OWNER_USER ?? "owner";
    const ghApp = appConfig();
    if (ghApp && process.env.DRY_RUN !== "1") {
      const client = new GitHubAppClient(ghApp);
      return queue.add(`github:push:${req.repo}`, () => stagedPush(appStageOps((path, init) => client.repoApi(req.repo, path, init)), { repo: req.repo, target: req.branch, ticket, message: req.message, files, key: signingKey() }));
    }
    const cred = await vault.get(user, "composio");
    let live = process.env.DRY_RUN !== "1" && !!cred?.apiKey?.startsWith("ck_");
    let mcp: ComposioConnectMcp | undefined;
    if (live) { mcp = new ComposioConnectMcp(cred!.apiKey); live = ((await mcp.listConnections(["github"])).github ?? 0) > 0; }
    const key = signingKey();
    const message = (f: { path: string; content: string | null }[]) => signedMessage(key, ticket, req.repo, req.branch, req.message, f);
    if (!live) return { dryRun: true, reason: process.env.DRY_RUN === "1" ? "DRY_RUN=1" : "no GitHub connection in Composio", stage: stageBranch(req.branch, ticket), commits: files.map(f => ({ tool: f.content === null ? "GITHUB_DELETE_A_FILE" : "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", args: { path: f.path, branch: stageBranch(req.branch, ticket), message: message([f]) } })) };
    return queue.add(`github:push:${req.repo}`, () => stagedPush(composioStageOps((t, a) => mcp!.execute(t, a, cred!.account), req.repo), { repo: req.repo, target: req.branch, ticket, message: req.message, files, key, perFile: true }));
  }

  const redeploy = opts.redeploy ?? (async (repo: string) => {
    const project = process.env[`CREATEOS_PROJECT_${repo.split("/")[1].toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    if (!project) return { skipped: true, reason: "no CreateOS project configured for this repo" };
    return new Promise((res, rej) => execFile("createos", ["deploy", "--project", project], { timeout: 120_000 }, (e, out) => e ? rej(e) : res({ project, out: out.slice(-500) })));
  });
  async function rollbackNow(p: { repo: string; branch: string; to?: string; ticket: string }) {
    let target = opts.rollback;
    if (!target) {
      const ghApp = appConfig();
      if (!ghApp || process.env.DRY_RUN === "1") return { dryRun: true, reason: ghApp ? "DRY_RUN=1" : "GitHub App not configured (DEPLOYBUG_APP_ID)" };
      const client = new GitHubAppClient(ghApp);
      const api = (path: string, init?: RequestInit) => client.repoApi(p.repo, path, init);
      target = { source: appRollbackSource(api), ops: appStageOps(api) };
    }
    const t = target;
    return queue.add(`github:rollback:${p.repo}`, () => runRollback(t.source, t.ops, { ...p, key: signingKey() }, () => redeploy(p.repo), t.wait));
  }

  async function decide(id: string, approve: boolean) {
    const r = await decideInner(id, approve);
    try { gstore.saveTickets(tickets); } catch {}
    return r;
  }
  async function decideInner(id: string, approve: boolean) {
    const t = tickets.get(id);
    if (!t || t.status !== "pending") return { error: "no pending ticket" };
    t.status = approve ? "approved" : "denied";
    if (!approve) { log({ ticket: id, status: "denied" }); return { status: "denied" }; }
    if (t.payload.kind === "rollback") {
      try { const result = await rollbackNow({ ...t.payload, ticket: id }); log({ ticket: id, status: "executed", result }); return { status: "executed", result }; }
      catch (e) { await notifier.sendAlert(templateAlert("rollback", e, id, tzOf())).catch(() => {}); return { status: "failed", error: String(e) }; }
    }
    if (t.payload.kind === "push") {
      try { const result = await runPush(t.payload); log({ ticket: id, status: "executed", result }); return { status: "executed", result }; }
      catch (e) { await notifier.sendAlert(templateAlert("github-worker push", e, id, tzOf(t.payload.req.user))).catch(() => {}); return { status: "failed", error: String(e) }; }
    }
    const re = policy.evaluate(t.payload);
    if (re.verdict === "block") { t.status = "denied"; log({ ticket: id, status: "blocked", reason: re.reason }); return { status: "blocked", reason: re.reason }; }
    let result;
    try { result = await execute(t.payload); }
    catch (e) { await notifier.sendAlert(templateAlert(`${t.payload.app}-worker`, e, id, tzOf(t.payload.user))).catch(() => {}); log({ ticket: id, status: "failed", error: String(e) }); return { status: "failed", error: String(e) }; }
    log({ ticket: id, status: "executed", result });
    return { status: "executed", result };
  }

  const ep = (prov: string, model: string) => { const r = resolveProvider(models, prov); return r.key && r.base ? { model, key: r.key, base: r.base } : undefined; };
  const runner = (() => {
    if (opts.runner) return opts.runner;
    if (process.env.DRY_RUN === "1" || process.env.CONSENSUS === "0") return undefined;
    const v = ep(models.brain.provider, models.brain.model), j = ep("openrouter", process.env.DECISION_MODEL ?? "z-ai/glm-5.3");
    return v && j ? deepagentRunner(role => role === "investigator" || role === "judge" ? j : v) : undefined;
  })();
  const store = opts.store ?? new ResultStore();
  const newPool = () => runner ? new AgentPool(runner) : undefined;
  async function critical(kind: string, subject: string, user?: string) {
    const pool = newPool();
    if (!pool) return undefined;
    const r = await tribunal(pool, store, kind, subject, 5);
    let ticketId: string | undefined;
    if (r.ticket) {
      const t: Ticket = { id: randomUUID().slice(0, 8), summary: `${kind} check ${r.path === "exhausted" ? "could not reach agreement" : "found a compromised checker"} (run ${r.runId})`, createdAt: Date.now(), status: "denied", payload: { kind: "tribunal", runId: r.runId } as any };
      tickets.set(t.id, t); ticketId = t.id;
      await notifier.sendAlert(templateAlert(`${kind}-tribunal`, new Error(t.summary), t.id, tzOf(user))).catch(() => {});
    }
    log({ tribunal: kind, run: r.runId, verdict: r.verdict, path: r.path, attempts: r.attempts, ticket: ticketId });
    return { ...r, ticketId };
  }
  const toolkitAgents = new ToolkitAgents(() => ep(models.brain.provider, models.brain.model), newPool);
  const connectFn = opts.connect ?? (async (toolkits: string[]) => {
    const cred = await vault.get(process.env.OWNER_USER ?? "owner", "composio");
    const key = cred?.apiKey ?? (existsSync("/tmp/keys/composio") ? readFileSync("/tmp/keys/composio", "utf8").trim() : "");
    if (!key.startsWith("ck_")) throw new Error("no Composio Connect key");
    const r: any = await new ComposioConnectMcp(key).callTool("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: toolkits.map(name => ({ name, action: "add" })) });
    return r?.data?.results ?? {};
  });

  const chargeOwner = opts.chargeLookup ?? (async (charge: string, user?: string) => {
    const key = (await vault.get(user ?? process.env.OWNER_USER ?? "owner", "stripe"))?.apiKey ?? process.env.STRIPE_SECRET_KEY;
    if (!key || !/^ch_[A-Za-z0-9]+$|^py_[A-Za-z0-9]+$/.test(charge)) return undefined;
    const r = await fetch(`https://api.stripe.com/v1/charges/${charge}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    return typeof j.customer === "string" ? j.customer : j.customer?.id;
  });
  const app = new Hono();
  const limiter = opts.rateLimiter ?? new RateLimiter();
  app.use("*", async (c, next) => {
    const key = c.req.header("authorization") ?? `ip:${c.req.header("x-forwarded-for") ?? (c.env as any)?.incoming?.socket?.remoteAddress ?? "local"}`;
    if (c.req.path !== "/health" && !limiter.allow(key)) return c.json({ error: "rate limited" }, 429);
    await next();
  });
  app.use("*", async (c, next) => { if (c.req.path === "/health" || vpn.allows(c)) return next(); return c.json({ error: "this gate only answers over its WireGuard VPN" }, 403); });
  const agentOnly = async (c: any, next: any) => { if (!isAgentOrOwner(c)) return c.json({ error: "unauthorized" }, 401); await next(); };
  const owner = async (c: any, next: any) => { if (!isOwner(c)) return c.json({ error: "unauthorized" }, 401); await next(); };
  app.use("/requests/*", agentOnly); app.use("/requests", agentOnly);

  const sessions = new Map<string, number>();
  const sessionOk = (c: any) => {
    const m = String(c.req.header("cookie") ?? "").match(/(?:^|;\s*)db_session=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    for (const [k, exp] of sessions) if (exp < Date.now()) sessions.delete(k);
    for (const k of sessions.keys()) if (safeEq(k, m[1])) return true;
    return false;
  };
  app.get("/", c => {
    const code = c.req.query("c");
    if (code) {
      if (!codes.consume(code)) return c.html(DASHBOARD, 401);
      const sid = randomBytes(24).toString("base64url");
      sessions.set(sid, Date.now() + 12 * 3600_000);
      return c.body(null, 302, { location: "/", "set-cookie": `db_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`, "cache-control": "no-store" });
    }
    return c.html(DASHBOARD, 200, { "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
  });
  app.get("/manifest.webmanifest", c => c.body(MANIFEST, 200, { "content-type": "application/manifest+json" }));
  app.get("/icon.svg", c => c.body(ICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));
  app.get("/ui/data", c => {
    if (!isOwner(c) && !sessionOk(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ workers: workers.list(), models: { brain: models.brain.model }, queue: queue.status(), telegram: notifier.enabled, dryRun: process.env.DRY_RUN === "1",
      connectors: CONNECTORS.map(k => ({ slug: k.slug, name: k.name, via: k.via })), connected: toolkitAgents.list().map(a => a.replace(/-agent$/, "")),
      tickets: [...tickets.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(t => ({ id: t.id, status: t.status, summary: t.summary.slice(0, 200), createdAt: t.createdAt })),
      runs: store.pending().map((r: any) => ({ id: r.id, kind: r.kind, verdict: r.verdict })), audit: audit.slice(-30).reverse().map(a => ({ at: a.at, verdict: a.verdict, status: a.status, ticket: a.ticket })) });
  });
  app.get("/status.json", c => c.json({ name: "deploybug-gate", workers: workers.list(), telegram: notifier.enabled, queue: queue.status(), models: { brain: models.brain.model, panel: models.panel.map(m => m.id ?? m.model), escalation: models.escalation?.model } }));
  app.get("/health", c => c.json({ ok: true }));
  const ownerOk = (c: any) => isOwner(c);
  app.post("/connect/code", c => ownerOk(c) ? c.json({ code: codes.issue(), expiresInSec: 600, url: `/connect?c=CODE` }) : c.json({ error: "unauthorized" }, 401));
  app.get("/connect", async c => {
    if (!ownerOk(c) && !codes.consume(c.req.query("c"))) return c.text("unauthorized", 401);
    const picked = (c.req.query("toolkits") ?? "").split(",").map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9_]+$/.test(x));
    const esc = (x: string) => x.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
    if (!picked.length) return c.html(`<!doctype html><meta name=viewport content="width=device-width"><title>Connect</title><h2>Connect your tools</h2><form method=get><input type=hidden name=c value="${codes.issue()}">${CONNECTORS.map(k => `<label style="display:block;font-size:1.3em;margin:.5em 0"><input type=checkbox name=tk value=${k.slug}> ${esc(k.name)} <small>${esc(k.category)}${k.via === "custom_mcp" ? " · custom MCP" : ""}</small></label>`).join("")}<button style="font-size:1.3em">Get links</button></form><script>document.forms[0].onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);location.search="?c="+encodeURIComponent(f.get("c"))+"&toolkits="+f.getAll("tk").join(",")}</script>`);
    try {
      const known = new Map(CONNECTORS.map(k => [k.slug, k]));
      const custom = picked.filter(p => known.get(p)?.via === "custom_mcp");
      const viaComposio = picked.filter(p => known.get(p)?.via === "composio");
      const res: Record<string, any> = viaComposio.length ? { ...(await connectFn(viaComposio)) } : {};
      for (const k of custom) res[k] = { status: "needs_setup", note: "Custom MCP: register its HTTPS endpoint in Composio with API_KEY auth, then connect" };
      for (const p of picked.filter(p => !known.has(p))) res[p] = { status: "not_in_catalog" };
      const links = Object.entries(res).map(([k, v]: any) => ({ toolkit: k, status: v.status, url: v.redirect_url }));
      if (c.req.header("accept")?.includes("application/json")) return c.json({ links });
      return c.html(`<!doctype html><meta name=viewport content="width=device-width"><h2>Tap each to connect</h2>${links.map(l => l.url ? `<p style="font-size:1.3em"><a href="${esc(l.url)}">Connect ${esc(l.toolkit)}</a></p>` : `<p>${esc(l.toolkit)}: ${esc(String(l.status))}</p>`).join("")}<p>Links expire in 10 minutes.</p>`);
    } catch (e) { return c.text("Composio is not configured", 502); }
  });
  app.post("/connect/sync", async c => {
    if (!ownerOk(c)) return c.json({ error: "unauthorized" }, 401);
    let counts = await c.req.json<Record<string, number>>().catch(() => ({} as Record<string, number>));
    if (!Object.keys(counts).length) {
      const key = existsSync("/tmp/keys/composio") ? readFileSync("/tmp/keys/composio", "utf8").trim() : "";
      if (key.startsWith("ck_")) counts = await new ComposioConnectMcp(key).listConnections(KNOWN_TOOLKITS).catch(() => ({}));
    }
    return c.json({ agents: toolkitAgents.sync(counts) });
  });
  app.get("/connect/catalog", c => principal(c) ? c.json(CONNECTORS) : c.json({ error: "unauthorized" }, 401));
  app.get("/connect/agents", c => ownerOk(c) ? c.json({ agents: toolkitAgents.list() }) : c.json({ error: "unauthorized" }, 401));
  app.post("/rollback", async c => {
    if (!isAgentOrOwner(c)) return c.json({ error: "unauthorized" }, 401);
    const b = await c.req.json<{ repo: string; branch?: string; to?: string; reason?: string }>();
    const pol = (policy.policies as any).push;
    const branch = b.branch ?? "main";
    if (!pol?.repos?.includes(b.repo)) return c.json({ error: `${b.repo} isn't on the list of repos` }, 403);
    if (b.to && !/^[0-9a-f]{7,40}$/.test(b.to)) return c.json({ error: "bad commit id" }, 400);
    const t: Ticket = { id: randomUUID().slice(0, 8), summary: `Rollback approval needed\nRoll ${b.repo} ${branch} back to ${b.to ? b.to.slice(0, 7) : "the last gate-signed good commit"} and redeploy.\nReason: ${(b.reason ?? "not given").slice(0, 200)}\nTime: ${formatTime(tzOf())}`, createdAt: Date.now(), status: "pending", payload: { kind: "rollback", repo: b.repo, branch, to: b.to } as any };
    tickets.set(t.id, t);
    const sent = await notifier.sendApproval(t).catch(e => ({ error: String(e) }));
    log({ rollback: b.repo, ticket: t.id });
    return c.json({ verdict: "pending_approval", ticket: t.id, telegram: sent && !(sent as any).skipped, message: t.summary }, 202);
  });
  async function autoRollback(repo: string, branch: string, evidence: string, user?: string) {
    const pol = (policy.policies as any).push;
    if (!pol?.repos?.includes(repo)) return { rolledBack: false, reason: "repo not managed" };
    const id = `auto-${randomUUID().slice(0, 8)}`;
    let result: any;
    try { result = await rollbackNow({ repo, branch, ticket: id }); } catch (e) { result = { pushed: false, error: String(e) }; }
    log({ autoRollback: repo, branch, ticket: id, result });
    await notifier.sendAlert(templateAlert("auto-rollback", new Error(`Hack or injection detected on ${repo} ${branch}. Rolled back automatically: ${result?.pushed ? "yes" : "no"}. Evidence: ${evidence.slice(0, 160)}`), id, tzOf(user))).catch(() => {});
    return { rolledBack: !!result?.pushed, ticket: id, result };
  }
  app.get("/vpn", c => ownerOk(c) ? c.json(vpn.status()) : c.json({ error: "unauthorized" }, 401));
  app.post("/vpn", async c => {
    if (!ownerOk(c)) return c.json({ error: "unauthorized" }, 401);
    const b = await c.req.json<{ enabled: boolean }>().catch(() => ({ enabled: false }));
    if (b.enabled && !vpn.status().peerConfig) return c.json({ error: "no WireGuard peer config yet, so VPN mode stays off to avoid a lockout" }, 409);
    log({ vpn: b.enabled === true });
    return c.json(vpn.set(b.enabled === true));
  });
  app.get("/vpn/config", async c => {
    if (!ownerOk(c)) return c.json({ error: "unauthorized" }, 401);
    const p = await vpn.peer();
    if (!p) return c.json({ error: "no WireGuard peer config on the gate" }, 404);
    if (c.req.query("format") === "qr") return c.body(p.qrSvg, 200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
    return c.json(p, 200, { "cache-control": "no-store" });
  });
  app.post("/incident", async c => {
    const incidentSecret = process.env.INCIDENT_WEBHOOK_SECRET;
    const raw = await c.req.text();
    const signedSource = !!incidentSecret && safeEq((c.req.header("x-deploybug-signature") ?? "").replace(/^sha256=/, ""), createHmac("sha256", incidentSecret).update(raw).digest("hex"));
    if (!ownerOk(c) && !signedSource) return c.json({ error: "owner token or signed source required" }, 401);
    let b: { repo: string; branch?: string; evidence: string };
    try { b = JSON.parse(raw); } catch { return c.json({ error: "bad json" }, 400); }
    const check = await checker.check(String(b.evidence ?? "").slice(0, 16000));
    const t = await critical("injection", String(b.evidence ?? ""));
    const hacked = !!t && t.verdict === "block" && (t.path !== "exhausted");
    if (!t && check.score < models.escalateBelow) { await notifier.sendAlert(templateAlert("incident", new Error(`Possible hack on ${b.repo}, but the checker tribunal is unavailable, so no automatic rollback. Use /rollback.`), undefined, tzOf())).catch(() => {}); return c.json({ hacked: "unconfirmed", score: check.score, rolledBack: false }); }
    if (!hacked) return c.json({ hacked: false, score: check.score, tribunal: t && { run: t.runId, path: t.path } });
    return c.json({ hacked: true, score: check.score, tribunal: t && { run: t.runId, path: t.path }, ...(await autoRollback(b.repo, b.branch ?? "main", String(b.evidence))) });
  });
  app.get("/runs/pending", c => ownerOk(c) ? c.json(store.pending().map((r: any) => ({ id: r.id, kind: r.kind, verdict: r.verdict, path: r.path }))) : c.json({ error: "unauthorized" }, 401));
  app.post("/composio/events", async c => {
    const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
    const raw = await c.req.text();
    if (secret) {
      const want = createHmac("sha256", secret).update(raw).digest("hex");
      const got = (c.req.header("x-composio-signature") ?? "").replace(/^sha256=/, "");
      if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return c.json({ error: "bad signature" }, 401);
    } else if (!ownerOk(c)) return c.json({ error: "unauthorized" }, 401);
    let ev: any; try { ev = JSON.parse(raw); } catch { return c.json({ error: "bad json" }, 400); }
    const check = await checker.check(raw.slice(0, 16000));
    if (check.score < models.escalateBelow) {
      log({ composioEvent: "blocked", score: check.score });
      const repo = ev?.repository?.full_name ?? ev?.data?.repository?.full_name;
      const ref = String(ev?.ref ?? ev?.data?.ref ?? "");
      const t = secret ? await critical("injection", raw.slice(0, 16000)) : undefined;
      const live = secret && t && t.verdict === "block" && t.path !== "exhausted" && repo && /^refs\/heads\//.test(ref) ? await autoRollback(repo, ref.replace("refs/heads/", ""), raw.slice(0, 400)) : undefined;
      return c.json({ routed: false, reason: "event looks like a prompt-injection attempt", rollback: live }, 403);
    }
    return c.json(await queue.add(`toolkit:event`, () => toolkitAgents.handle(ev)));
  });
  app.use("/media/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["Authorization"] }));
  app.get("/media/current", async c => {
    if (!principal(c)) return c.json({ error: "unauthorized" }, 401);
    try {
      const m = await media.current();
      if (!m) return c.json({ playbackId: null }, 404);
      return c.json({ playbackId: m.playbackId, title: m.title ?? null, description: m.description ?? null });
    } catch (e) { return c.json({ error: "media unavailable" }, 502); }
  });
  app.get("/workers", c => isAgentOrOwner(c) ? c.json(workers.list()) : c.json({ error: "unauthorized" }, 401));
  app.use("/audit", owner); app.use("/tickets", owner);
  app.get("/audit", c => c.json(audit.slice(-100)));
  app.get("/tickets", c => c.json([...tickets.values()]));

  app.post("/requests", async c => {
    const req = (await c.req.json()) as ActionRequest;
    const who = principal(c)!; req.user = who.user; req.agent = `${who.role}:${req.agent ?? "agent"}`.slice(0, 80);
    const text = [req.text ?? "", JSON.stringify(req.args ?? {})].join("\n");
    const check = await checker.check(text);
    if (check.score < models.escalateBelow) {
      log({ req, verdict: "block", check });
      return c.json({ verdict: "block", reason: "This looks like a prompt-injection attempt, so it was blocked", check }, 403);
    }
    const refundRule = policy.app(req.app)?.rules?.refund;
    if (refundRule && refundRule.tool === req.tool) {
      const charge = String((req.args as any)?.charge ?? (req.args as any)?.charge_id ?? "");
      const owner = charge ? await chargeOwner(charge, req.user).catch(() => undefined) : undefined;
      if (owner) (req.args as any).customer = owner;
      else if (process.env.DRY_RUN !== "1") { log({ req, verdict: "block", reason: "charge lookup failed" }); return c.json({ verdict: "block", reason: "The customer couldn't be confirmed from the charge with Stripe, so the refund was blocked" }, 403); }
    }
    const d = policy.evaluate(req);
    if (d.verdict === "block") { log({ req, ...d, check }); return c.json({ ...d, check }, 403); }
    const kind = /REFUND/i.test(req.tool ?? "") ? "refund" : check.score < 85 ? "injection" : undefined;
    const cons = kind ? await critical(kind, `${req.app}.${req.tool}\n${text}`, req.user) : undefined;
    if (cons && cons.verdict === "block") return c.json({ verdict: "block", reason: cons.ticket ? "The two independent checkers could not agree, so it was blocked and a ticket was raised" : "Both independent checkers blocked this", tribunal: { run: cons.runId, path: cons.path, attempts: cons.attempts, ticket: cons.ticketId } }, 403);
    if (d.verdict === "approve") {
      const t: Ticket = { id: randomUUID().slice(0, 8), summary: `${req.agent ?? "agent"} → ${req.app}.${req.tool}\n${JSON.stringify(req.args)}\n${d.reason}`, createdAt: Date.now(), status: "pending", payload: req };
      tickets.set(t.id, t);
      const sum = notifier.enabled ? await summarizeTicket(models, factsFromRequest(req, d.reason, t.id)) : undefined;
      const sent = await notifier.sendApproval(t, sum ? `${sum.text}\nTime: ${formatTime(tzOf(req.user))}` : undefined).catch(e => ({ error: String(e) }));
      log({ req, ...d, ticket: t.id, check, summary: sum });
      return c.json({ verdict: "pending_approval", ticket: t.id, reason: d.reason, message: sum?.text, summary: sum && { verified: sum.verified, loops: sum.loops, source: sum.source }, telegram: sent && !(sent as any).skipped, check }, 202);
    }
    let result;
    try { result = await execute(req); }
    catch (e) { await notifier.sendAlert(templateAlert(`${req.app}-worker`, e, undefined, tzOf(req.user))).catch(() => {}); log({ req, verdict: "failed", error: String(e) }); return c.json({ verdict: "failed", error: String(e) }, 502); }
    log({ req, verdict: "allow", check, result });
    return c.json({ verdict: "allow", result, check });
  });

  app.use("/users/*", owner);
  app.put("/users/:user/credentials/:provider", async c => {
    const body = await c.req.json<Record<string, string>>();
    if (!body.apiKey) return c.json({ error: "apiKey required" }, 400);
    await vault.set(c.req.param("user"), c.req.param("provider"), body);
    return c.json({ saved: true, provider: c.req.param("provider") });
  });
  app.get("/users/:user/profile", c => c.json(profiles.get(c.req.param("user"))));
  app.put("/users/:user/profile", async c => {
    try { return c.json(profiles.set(c.req.param("user"), await c.req.json())); }
    catch (e: any) { return c.json({ error: e.message }, 400); }
  });
  app.get("/users/:user/credentials", async c => c.json({ providers: await vault.list(c.req.param("user")) }));
  app.delete("/users/:user/credentials/:provider", async c => { await vault.remove(c.req.param("user"), c.req.param("provider")); return c.json({ removed: true }); });

  app.use("/push", agentOnly);
  app.post("/push", async c => {
    const req = await c.req.json<PushRequest>();
    const who = principal(c)!; req.user = who.user; req.agent = who.role === "owner" ? "owner" : `agent:${String(req.agent ?? "agent").slice(0, 60)}`;
    const pol = (policy.policies as any).push;
    if (!pol) return c.json({ error: "push policy not configured" }, 500);
    const rp = resolveProvider(models, models.brain.provider);
    const agentReview = await reviewPush(rp.key && rp.base ? { model: models.brain.model, key: rp.key, base: rp.base } : undefined, req.files ?? [], req.message ?? "");
    const a = await analysePush(req, pol, checker, models.escalateBelow, agentReview.proposals);
    const cons = a.verdict === "block" ? undefined : await critical("push", [req.message, ...a.sanitized.filter(f => f.content !== null).map(f => `FILE ${f.path}:\n${f.content}`)].join("\n\n").slice(0, 16000), req.user);
    if (cons && cons.verdict === "block") { a.verdict = "block"; a.reasons.push(cons.ticket ? "The two independent checkers could not agree, so it was blocked and a ticket was raised" : "Both independent checkers blocked this push"); }
    const summary = { agent: agentReview.summary, verdict: a.verdict, reasons: a.reasons, files: a.files, gateChanges: a.gateChanges, score: a.score, scanModel: a.scanModel, secrets: a.secrets };
    if (a.verdict === "block") { log({ push: req.repo, branch: req.branch, ...summary }); return c.json(summary, 403); }
    if (a.verdict === "approve") {
      const t: Ticket = { id: randomUUID().slice(0, 8), summary: "", createdAt: Date.now(), status: "pending", payload: { kind: "push", req: { ...req, files: undefined, diff: undefined }, files: a.sanitized, ticket: "" } };
      t.payload.ticket = t.id;
      t.summary = pushTicketText(t.id, req, a, formatTime(tzOf(req.user)));
      tickets.set(t.id, t);
      const sent = await notifier.sendApproval(t).catch(e => ({ error: String(e) }));
      log({ push: req.repo, branch: req.branch, ticket: t.id, ...summary });
      return c.json({ ...summary, verdict: "pending_approval", ticket: t.id, telegram: sent && !(sent as any).skipped, message: t.summary }, 202);
    }
    const result = await runPush({ req, files: a.sanitized, ticket: `auto-${randomUUID().slice(0, 8)}` });
    log({ push: req.repo, branch: req.branch, ...summary, result });
    return c.json({ ...summary, result });
  });

  app.get("/users/:user/connections", async c => {
    const cred = await vault.get(c.req.param("user"), "composio");
    if (!cred?.apiKey) return c.json({ error: "no composio key stored" }, 404);
    if (!cred.apiKey.startsWith("ck_")) return c.json({ error: "listing implemented for Connect (ck_) keys only" }, 501);
    const list = (c.req.query("toolkits") ?? "stripe,github,sentry,supabase").split(",");
    return c.json({ active: await new ComposioConnectMcp(cred.apiKey).listConnections(list) });
  });

  const ingested: any[] = [];
  const findings = new Map<string, any>();
  app.post("/ingest/github", async c => {
    const raw = await c.req.text();
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    let signed = false;
    if (secret) {
      const sig = c.req.header("x-hub-signature-256") ?? "";
      const want = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
      if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return c.json({ error: "bad signature" }, 401);
      signed = true;
    } else {
      if (!isAgentOrOwner(c)) return c.json({ error: "unauthorized" }, 401);
      signed = false;
    }
    const rec: any = await ingestComment({ ev: JSON.parse(raw), signed, sources: (policy.policies as any).sources ?? {}, checker, threshold: models.escalateBelow });
    if (!rec) return c.json({ ignored: true });
    if (rec.trust === "trusted" && rec.severity !== "minor") {
      const id = randomUUID().slice(0, 8);
      findings.set(id, { id, status: "open", ...rec });
      rec.findingTicket = id;
      if (process.env.INGEST_ALERTS === "1")
        await notifier.sendAlert(`CodeRabbit review finding (ticket ${id})\nRepo: ${rec.repo} PR #${rec.pr}\nSeverity: ${rec.severity}${rec.blocksDeploy ? " - deploy blocked until resolved" : ""}\n${rec.finding.split("\n")[0].slice(0, 200)}\nTime: ${formatTime(tzOf())}`).catch(() => {});
    }
    if (rec.trust === "untrusted" && rec.flagged && process.env.INGEST_ALERTS === "1")
      await notifier.sendAlert(`Deploy Bug flagged a comment\nRepo: ${rec.repo} PR #${rec.pr}\nAuthor: ${rec.author}\nSafety score: ${rec.score}/100\nIt was quarantined and no agent will act on it.\nTime: ${formatTime(tzOf())}`).catch(() => {});
    ingested.push(rec); if (ingested.length > 200) ingested.shift();
    log({ ingest: rec });
    return c.json(rec);
  });
  app.get("/deploy/status", c => {
    if (!principal(c)) return c.json({ error: "unauthorized" }, 401);
    const repo = c.req.query("repo"), pr = c.req.query("pr");
    const open = [...findings.values()].filter(f => f.status === "open" && f.blocksDeploy && (!repo || f.repo === repo) && (!pr || String(f.pr) === pr));
    return c.json({ deploy: open.length ? "blocked" : "ok", blockingFindings: open.map(f => ({ id: f.id, severity: f.severity, pr: f.pr, url: f.url })) });
  });
  app.use("/findings/*", owner);
  app.post("/findings/:id/resolve", c => { const f = findings.get(c.req.param("id")); if (!f) return c.json({ error: "not found" }, 404); f.status = "resolved"; return c.json({ resolved: true }); });
  app.use("/ingest/log", owner);
  app.get("/ingest/log", c => c.json(ingested.slice(-50)));

  app.post("/tickets/:id/:action{approve|deny}", async c => {
    if (!isOwner(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json(await decide(c.req.param("id"), c.req.param("action") === "approve"));
  });

  return { app, queue, decide, notifier, policy, workers };
}
