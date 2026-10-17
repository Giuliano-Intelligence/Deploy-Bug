import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Access = "read" | "write" | "both";
export interface ToolSpec { name: string; kind: "read" | "write" }
export interface RefundRule { tool: string; maxAmountMinor: number; currency: string; oncePerCustomer: boolean; singleChargeOnly: boolean; requireApprovalAboveMinor: number }
export interface AppPolicy { enabled?: boolean; provider: string; access: Access; tools: ToolSpec[]; rules?: { refund?: RefundRule } }
export interface PolicyFile { apps: Record<string, AppPolicy> }

export interface ActionRequest {
  app: string; tool: string; args: Record<string, unknown>;
  agent?: string; text?: string; user?: string;
}
export type Decision =
  | { verdict: "allow"; reason: string }
  | { verdict: "approve"; reason: string }
  | { verdict: "block"; reason: string };

export function loadPolicies(path = "config/policies.yaml"): PolicyFile {
  const f = parse(readFileSync(path, "utf8")) as PolicyFile;
  for (const [k, v] of Object.entries(f.apps)) if (v.enabled === false) delete f.apps[k];
  return f;
}

const BULK = /\b(all|every(one|body)?|each|bulk|mass)\b/i;

export class PolicyEngine {
  private refunded = new Set<string>();
  constructor(public policies: PolicyFile) {}

  app(name: string) { return this.policies.apps[name]; }

  evaluate(req: ActionRequest): Decision {
    const app = this.app(req.app);
    if (!app) return { verdict: "block", reason: `${req.app} isn't connected to Deploy Bug` };
    const tool = app.tools.find(t => t.name === req.tool);
    if (!tool) return { verdict: "block", reason: `That ${req.app} action isn't on the allowed list` };
    if (tool.kind === "write" && app.access === "read") return { verdict: "block", reason: `${req.app} is read-only, so changes are blocked` };
    if (tool.kind === "read" && app.access === "write") return { verdict: "block", reason: `${req.app} is write-only, so reading is blocked` };

    const r = app.rules?.refund;
    if (r && r.tool === req.tool) {
      const a = req.args as any;
      if (req.text && BULK.test(req.text)) return { verdict: "block", reason: "Refunding lots of people at once is never allowed" };
      const charges = a.charge_ids ?? (a.charge ? [a.charge] : []);
      if (r.singleChargeOnly && (Array.isArray(charges) ? charges.length : 0) !== 1)
        return { verdict: "block", reason: "A refund must name exactly one payment" };
      const amt = Number(a.amount);
      if (!Number.isFinite(amt) || amt <= 0) return { verdict: "block", reason: "The refund amount is missing" };
      if (amt > r.maxAmountMinor) return { verdict: "block", reason: `Refunds over £${(r.maxAmountMinor / 100).toFixed(2)} are blocked (asked for £${(amt / 100).toFixed(2)})` };
      if ((a.currency ?? r.currency).toLowerCase() !== r.currency) return { verdict: "block", reason: `Refunds must be in ${r.currency.toUpperCase()}` };
      if (r.oncePerCustomer) {
        if (!a.customer) return { verdict: "block", reason: "The customer is missing, so the one-refund-per-customer rule can't be checked" };
        if (this.refunded.has(a.customer)) return { verdict: "block", reason: `Customer ${a.customer} has already had a refund` };
      }
      if (amt > r.requireApprovalAboveMinor) return { verdict: "approve", reason: "Refunds always need your sign-off" };
    }
    return tool.kind === "write"
      ? { verdict: "approve", reason: "Changes always need your sign-off" }
      : { verdict: "allow", reason: "Read-only and on the allowed list" };
  }

  recordExecuted(req: ActionRequest) {
    const r = this.app(req.app)?.rules?.refund;
    if (r && r.tool === req.tool && (req.args as any).customer) this.refunded.add((req.args as any).customer);
  }
}
