import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export interface ToolContext { user?: string; credentials?: Record<string, string> }
export interface ToolProvider {
  id: string;
  execute(tool: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<unknown>;
}

export class ComposioConnectMcp {
  private sid?: string; private n = 0;
  constructor(private key: string, private url = "https://connect.composio.dev/mcp", private timeoutMs = 30_000) {}
  private async rpc(method: string, params: unknown, notify = false) {
    const h: Record<string, string> = { "x-consumer-api-key": this.key, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.sid) h["mcp-session-id"] = this.sid;
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++this.n, method, params };
    const r = await fetch(this.url, { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new Error(`composio mcp http ${r.status}`);
    this.sid = r.headers.get("mcp-session-id") ?? this.sid;
    let t = await r.text(); const d = t.split("\n").filter(l => l.startsWith("data:")).pop(); if (d) t = d.slice(5);
    return t.trim() ? JSON.parse(t) : undefined;
  }
  async init() { if (this.sid) return; await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "deploybug", version: "0.1" } }); await this.rpc("notifications/initialized", {}, true); }
  async callTool(name: string, args: unknown) {
    await this.init(); const r = await this.rpc("tools/call", { name, arguments: args });
    const text = r?.result?.content?.[0]?.text; try { return JSON.parse(text); } catch { return text ?? r; }
  }
  async listConnections(toolkits: string[]) {
    const r: any = await this.callTool("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: toolkits.map(name => ({ name, action: "list" })) });
    return Object.fromEntries(Object.entries(r?.data?.results ?? {}).map(([k, v]: any) => [k, (v.accounts ?? []).filter((a: any) => /active/i.test(a.status ?? "")).length]));
  }
  async execute(tool: string, args: Record<string, unknown>, account?: string) {
    const r: any = await this.callTool("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: tool, arguments: args, ...(account ? { account } : {}) }], thought: "Deploy Bug approved action" });
    if (r?.successful === false) throw new Error(`composio ${tool} failed: ${r.error ?? "unknown"}`);
    return r?.data ?? r;
  }
}

export class ComposioProvider implements ToolProvider {
  id = "composio";
  async execute(tool: string, args: Record<string, unknown>, ctx: ToolContext = {}) {
    const apiKey = ctx.credentials?.apiKey;
    if (!apiKey) throw new Error(`user '${ctx.user}' has no Composio key — add it in the PWA (PUT /users/:user/credentials/composio)`);
    if (apiKey.startsWith("ck_")) return new ComposioConnectMcp(apiKey).execute(tool, args, ctx.credentials?.account);
    const { Composio } = await import("@composio/core");
    const c = new Composio({ apiKey });
    const r = await c.tools.execute(tool, { userId: ctx.credentials?.userId ?? ctx.user ?? "default", arguments: args, dangerouslySkipVersionCheck: true });
    if (r && r.successful === false) throw new Error(`composio ${tool} failed: ${r.error ?? "unknown"}`);
    return r;
  }
}

export class MuxProvider implements ToolProvider {
  id = "mux";
  async execute(tool: string, args: Record<string, unknown>) {
    if (tool !== "MUX_GET_PLAYBACK_INFO") throw new Error(`mux tool ${tool} not supported (read-only)`);
    const id = String(args.playback_id ?? "");
    const tid = process.env.MUX_TOKEN_ID, sec = process.env.MUX_TOKEN_SECRET;
    if (tid && sec && id) {
      const r = await fetch(`https://api.mux.com/video/v1/playback-ids/${encodeURIComponent(id)}`, {
        headers: { authorization: "Basic " + Buffer.from(`${tid}:${sec}`).toString("base64") } });
      return r.json();
    }
    return { stub: true, playback_id: id, stream_url: `https://stream.mux.com/${id}.m3u8`, poster: `https://image.mux.com/${id}/thumbnail.jpg` };
  }
}

export class DryRunProvider implements ToolProvider {
  id = "dry-run";
  async execute(tool: string, args: Record<string, unknown>, ctx: ToolContext = {}) { return { dryRun: true, tool, args, user: ctx.user, hasCredentials: Boolean(ctx.credentials) }; }
}

export function providerRegistry(): Record<string, ToolProvider> {
  const dry = process.env.DRY_RUN === "1";
  return dry ? { composio: new DryRunProvider(), mux: new MuxProvider(), "composio-live": new ComposioProvider() }
             : { composio: new ComposioProvider(), mux: new MuxProvider(), "composio-live": new ComposioProvider() };
}

export class HiveContentCheck {
  get enabled() { return process.env.HIVE_ENABLED === "1"; }
  private key() {
    if (process.env.HIVE_API_KEY) return process.env.HIVE_API_KEY;
    try { return require("node:fs").readFileSync(process.env.HIVE_KEY_FILE ?? "/tmp/keys/hive", "utf8").trim(); } catch { return undefined; }
  }
  async check(mediaUrl: string): Promise<{ enabled: boolean; aiGenerated?: number; raw?: unknown; error?: string }> {
    if (!this.enabled) return { enabled: false };
    const k = this.key(); if (!k) return { enabled: true, error: "no Hive key" };
    const r = await fetch("https://api.thehive.ai/api/v2/task/sync", { method: "POST",
      headers: { authorization: `Token ${k}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: mediaUrl }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return { enabled: true, error: `http ${r.status}` };
    const raw: any = await r.json();
    const classes = raw?.status?.[0]?.response?.output?.[0]?.classes ?? [];
    const ai = classes.find((c: any) => c.class === "ai_generated")?.score;
    return { enabled: true, aiGenerated: ai, raw };
  }
}
