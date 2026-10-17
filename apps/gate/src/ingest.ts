import type { InjectionChecker } from "@deploybug/checker";

export interface SourcePolicy { trust: "trusted" | "untrusted"; login?: string; userType?: string; severity?: Record<string, string>; blockDeployOn?: string[] }

export function classifySeverity(text: string, sev: Record<string, string> = {}): string {
  for (const [level, re] of Object.entries(sev)) if (new RegExp(re, "i").test(text)) return level;
  return "minor";
}
const stripMeta = (b: string) => b.replace(/<!--[\s\S]*?-->/g, "").trim();

export async function ingestComment(opts: { ev: any; signed: boolean; sources: Record<string, SourcePolicy>; checker: InjectionChecker; threshold: number }) {
  const { ev, signed, sources, checker, threshold } = opts;
  const item = ev.comment ?? ev.review; if (!item?.body) return undefined;
  const login = item.user?.login ?? "unknown", type = item.user?.type;
  const [name, pol] = Object.entries(sources).find(([k, p]) => k !== "default" && p.login === login) ?? ["default", sources.default ?? { trust: "untrusted" as const }];
  const identityOk = pol.login === login && (!pol.userType || pol.userType === type);
  const trusted = pol.trust === "trusted" && identityOk && signed;
  const base = { repo: ev.repository?.full_name, pr: ev.pull_request?.number ?? ev.issue?.number, author: login, source: name, url: item.html_url, at: new Date().toISOString() };
  if (trusted) {
    const finding = stripMeta(item.body);
    const severity = classifySeverity(finding, pol.severity);
    return { ...base, trust: "trusted", severity, blocksDeploy: (pol.blockDeployOn ?? []).includes(severity), finding: finding.slice(0, 400) };
  }
  const check = await checker.check(item.body);
  return { ...base, trust: "untrusted", why: pol.trust === "trusted" ? (identityOk ? "webhook not signed, identity unverified" : "author identity mismatch") : "untrusted source",
    flagged: check.score < threshold, score: check.score, check };
}
