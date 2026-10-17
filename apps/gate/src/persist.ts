import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export class GateStore {
  constructor(private dir = process.env.DEPLOYBUG_STATE_DIR ?? "data") { mkdirSync(dir, { recursive: true }); }
  loadTickets<T>(): [string, T][] { try { return Object.entries(JSON.parse(readFileSync(join(this.dir, "tickets.json"), "utf8"))) as [string, T][]; } catch { return []; } }
  saveTickets(m: Map<string, unknown>) { const f = join(this.dir, "tickets.json"); writeFileSync(f + ".tmp", JSON.stringify(Object.fromEntries(m))); renameSync(f + ".tmp", f); }
  appendAudit(e: unknown) { appendFileSync(join(this.dir, "audit.jsonl"), JSON.stringify(e) + "\n"); }
  loadAudit(n = 500): any[] {
    const f = join(this.dir, "audit.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).slice(-n).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
  }
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMin = Number(process.env.RATE_LIMIT_PER_MIN ?? 120)) {}
  allow(key: string, now = Date.now()) {
    const k = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const arr = (this.hits.get(k) ?? []).filter(t => now - t < 60_000);
    if (arr.length >= this.perMin) { this.hits.set(k, arr); return false; }
    arr.push(now); this.hits.set(k, arr); return true;
  }
}
