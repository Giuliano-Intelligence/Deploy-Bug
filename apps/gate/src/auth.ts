import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function safeEq(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

export type Principal = { role: "owner" | "agent" | "bugflix"; user: string };

export function gateTokens() {
  const owner = process.env.GATE_OWNER_TOKEN, agent = process.env.GATE_AGENT_TOKEN;
  if (!owner || owner.length < 24) throw new Error("GATE_OWNER_TOKEN is required (24+ chars); refusing to start");
  if (!agent || agent.length < 24) throw new Error("GATE_AGENT_TOKEN is required (24+ chars); refusing to start");
  if (safeEq(owner, agent)) throw new Error("GATE_OWNER_TOKEN must differ from GATE_AGENT_TOKEN");
  return { owner, agent, bugflix: process.env.BUGFLIX_GATE_TOKEN || agent };
}

export function principal(c: any): Principal | undefined {
  const t = gateTokens();
  const h = String(c.req.header("authorization") ?? "");
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : undefined;
  const user = process.env.OWNER_USER ?? "owner";
  if (safeEq(bearer, t.owner)) return { role: "owner", user };
  if (safeEq(bearer, t.agent)) return { role: "agent", user: process.env.GATE_AGENT_USER ?? user };
  if (safeEq(bearer, t.bugflix)) return { role: "bugflix", user };
  return undefined;
}

export const isOwner = (c: any) => principal(c)?.role === "owner";
export const isAgentOrOwner = (c: any) => { const p = principal(c)?.role; return p === "owner" || p === "agent"; };

export class OneTimeCodes {
  private codes = new Map<string, number>();
  constructor(private ttlMs = 600_000) {}
  issue() { const c = randomBytes(18).toString("base64url"); this.codes.set(c, Date.now() + this.ttlMs); return c; }
  consume(c: string | undefined) {
    if (!c) return false;
    for (const [k, exp] of this.codes) if (exp < Date.now()) this.codes.delete(k);
    for (const k of this.codes.keys()) if (safeEq(k, c)) { this.codes.delete(k); return true; }
    return false;
  }
}
