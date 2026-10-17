import { runAppAgent, type AgentModel } from "./agent.ts";
import type { AgentPool } from "./pool.ts";

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Connector { slug: string; name: string; via: "composio" | "custom_mcp"; category: string; mcp?: string; auth?: string }
export function loadConnectors(path = process.env.CONNECTORS_FILE ?? "config/connectors.yaml"): Connector[] {
  try { return ((parse(readFileSync(path, "utf8")) as any)?.connectors ?? []).filter((c: any) => /^[a-z0-9_]+$/.test(c?.slug ?? "")); } catch { return []; }
}
export const CONNECTORS = loadConnectors();
export const KNOWN_TOOLKITS = CONNECTORS.map(c => c.slug);

export class ToolkitAgents {
  private connected = new Set<string>();
  constructor(private model: () => AgentModel | undefined, private pool?: () => AgentPool | undefined) {}
  sync(counts: Record<string, number>) { for (const [k, n] of Object.entries(counts)) if (n > 0) this.connected.add(k.toLowerCase()); return this.list(); }
  list() { return [...this.connected].sort().map(t => `${t}-agent`); }
  has(t: string) { return this.connected.has(t.toLowerCase()); }
  toolkitOf(ev: any): string | undefined {
    const raw = String(ev?.toolkit ?? ev?.data?.toolkit ?? ev?.metadata?.toolkit ?? ev?.type ?? ev?.trigger_slug ?? ev?.triggerSlug ?? "").toLowerCase();
    const slug = raw.split(/[_.:]/)[0];
    return slug && this.has(slug) ? slug : undefined;
  }
  async handle(ev: any) {
    const t = this.toolkitOf(ev);
    if (!t) return { routed: false, reason: "no connected toolkit matches this event" };
    const pool = this.pool?.();
    if (pool && process.env.DRY_RUN !== "1") { const r = await pool.step("tool_worker", `Tool ${t} event:\n${JSON.stringify(ev).slice(0, 6000)}`, t); return { routed: true, agent: r.id, summary: r.out, proposals: [] }; }
    const m = this.model();
    if (!m || process.env.DRY_RUN === "1") return { routed: true, agent: `${t}-agent`, summary: "agent run skipped (dry run)", proposals: [] };
    const r = await runAppAgent({ app: t, model: m, readTools: [], instruction: `A ${t} event arrived. Summarise it and propose nothing unless a gate action applies. Event: ${JSON.stringify(ev).slice(0, 6000)}`,
      systemPrompt: `You are the ${t}-agent in Deploy Bug. You only summarise and propose; the policy package decides.` });
    return { routed: true, agent: `${t}-agent`, ...r };
  }
}
