import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { signCommit, trailers } from "@deploybug/policy";
import { ComposioConnectMcp } from "@deploybug/providers";
import { ingestComment } from "./ingest.ts";
import { analysePush, pushTicketText, type PushRequest } from "./push.ts";
import { randomUUID } from "node:crypto";
import { PolicyEngine, loadPolicies, type ActionRequest } from "@deploybug/policy";
import { InjectionChecker, loadModels } from "@deploybug/checker";
import { providerRegistry } from "@deploybug/providers";
import { WorkerFactory } from "@deploybug/workers";
import { FileVault, ProfileStore, type CredentialStore } from "@deploybug/vault";
import { factsFromRequest, summarizeTicket, templateAlert, formatTime } from "@deploybug/summarizer";
import { createQueue } from "@deploybug/queue";
import { TelegramNotifier, type Ticket } from "@deploybug/notifier";

export function buildGate(opts: { notifier?: TelegramNotifier; vault?: CredentialStore } = {}) {
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
  const tickets = new Map<string, Ticket>();
  const audit: any[] = [];
  const log = (e: any) => { audit.push({ at: new Date().toISOString(), ...e }); if (audit.length > 500) audit.shift(); };

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
    const cred = await vault.get(user, "composio");
    let live = process.env.DRY_RUN !== "1" && !!cred?.apiKey?.startsWith("ck_");
    let mcp: ComposioConnectMcp | undefined;
    if (live) { mcp = new ComposioConnectMcp(cred!.apiKey); live = ((await mcp.listConnections(["github"])).github ?? 0) > 0; }
    const [owner, repo] = req.repo.split("/");
    const key = signingKey();
    const calls = files.map(f => {
      const message = req.message + trailers(ticket, signCommit(key, ticket, req.repo, req.branch, [f]));
      return f.content === null
        ? { tool: "GITHUB_DELETE_A_FILE", args: { owner, repo, path: f.path, branch: req.branch, message } }
        : { tool: "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", args: { owner, repo, path: f.path, branch: req.branch, message, content: Buffer.from(f.content).toString("base64") } };
    });
    if (!live) return { dryRun: true, reason: process.env.DRY_RUN === "1" ? "DRY_RUN=1" : "no GitHub connection in Composio", commits: calls.map(c => ({ ...c, args: { ...c.args, ...("content" in c.args ? { content: `<${String(c.args.content).length} base64 chars>` } : {}) } })) };
    return queue.add(`github:push:${req.repo}`, async () => {
      const out = []; for (const c of calls) out.push(await mcp!.execute(c.tool, c.args, cred!.account)); return { dryRun: false, results: out };
    });
  }

  async function decide(id: string, approve: boolean) {
    const t = tickets.get(id);
    if (!t || t.status !== "pending") return { error: "no pending ticket" };
    t.status = approve ? "approved" : "denied";
    if (!approve) { log({ ticket: id, status: "denied" }); return { status: "denied" }; }
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

  const app = new Hono();
  const token = process.env.GATE_AGENT_TOKEN;
  app.use("/requests/*", async (c, next) => { if (token && c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401); await next(); });
  app.use("/requests", async (c, next) => { if (token && c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401); await next(); });

  app.get("/", c => c.json({ name: "deploybug-gate", workers: workers.list(), telegram: notifier.enabled, queue: queue.status(), models: { brain: models.brain.model, panel: models.panel.map(m => m.id ?? m.model), escalation: models.escalation?.model } }));
  app.get("/health", c => c.json({ ok: true }));
  app.get("/workers", c => c.json(workers.list()));
  const owner = async (c: any, next: any) => { const t = process.env.GATE_OWNER_TOKEN ?? token; if (t && c.req.header("authorization") !== `Bearer ${t}`) return c.json({ error: "unauthorized" }, 401); await next(); };
  app.use("/audit", owner); app.use("/tickets", owner);
  app.get("/audit", c => c.json(audit.slice(-100)));
  app.get("/tickets", c => c.json([...tickets.values()]));

  app.post("/requests", async c => {
    const req = (await c.req.json()) as ActionRequest;
    const text = [req.text ?? "", JSON.stringify(req.args ?? {})].join("\n");
    const check = await checker.check(text);
    if (check.score < models.escalateBelow) {
      log({ req, verdict: "block", check });
      return c.json({ verdict: "block", reason: "This looks like a prompt-injection attempt, so it was blocked", check }, 403);
    }
    const d = policy.evaluate(req);
    if (d.verdict === "block") { log({ req, ...d, check }); return c.json({ ...d, check }, 403); }
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

  app.use("/push", async (c, next) => { if (token && c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401); await next(); });
  app.post("/push", async c => {
    const req = await c.req.json<PushRequest>();
    const pol = (policy.policies as any).push;
    if (!pol) return c.json({ error: "push policy not configured" }, 500);
    const a = await analysePush(req, pol, checker, models.escalateBelow);
    const summary = { verdict: a.verdict, reasons: a.reasons, files: a.files, gateChanges: a.gateChanges, score: a.score, scanModel: a.scanModel, secrets: a.secrets };
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
      if (token && c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
      signed = process.env.INGEST_TRUST_UNSIGNED === "1";
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
    const repo = c.req.query("repo"), pr = c.req.query("pr");
    const open = [...findings.values()].filter(f => f.status === "open" && f.blocksDeploy && (!repo || f.repo === repo) && (!pr || String(f.pr) === pr));
    return c.json({ deploy: open.length ? "blocked" : "ok", blockingFindings: open.map(f => ({ id: f.id, severity: f.severity, pr: f.pr, url: f.url })) });
  });
  app.use("/findings/*", owner);
  app.post("/findings/:id/resolve", c => { const f = findings.get(c.req.param("id")); if (!f) return c.json({ error: "not found" }, 404); f.status = "resolved"; return c.json({ resolved: true }); });
  app.use("/ingest/log", owner);
  app.get("/ingest/log", c => c.json(ingested.slice(-50)));

  app.post("/tickets/:id/:action{approve|deny}", async c => {
    if (token && c.req.header("authorization") !== `Bearer ${process.env.GATE_OWNER_TOKEN ?? token}`) return c.json({ error: "unauthorized" }, 401);
    return c.json(await decide(c.req.param("id"), c.req.param("action") === "approve"));
  });

  return { app, queue, decide, notifier, policy, workers };
}
