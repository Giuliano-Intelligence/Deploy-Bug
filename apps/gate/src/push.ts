import { stripComments, scanSecrets, type SecretHit } from "@deploybug/sanitize";
import type { InjectionChecker } from "@deploybug/checker";
import { GATE_ACTIONS, GateActionGuard, removeDependency, type GateChange } from "@deploybug/policy";

export interface PushPolicy { repos: string[]; branches: string[]; protectedBranches: string[]; alwaysRequireApproval?: boolean; keepLicenseHeaders?: boolean; stripConfigComments?: boolean; maxFiles?: number; maxFileBytes?: number; gateActions?: string[]; autoDeleteFiles?: string[]; removeDependencies?: string[]; injectionExemptPaths?: string[] }
export interface PushFile { path: string; content: string | null }
export interface PushRequest { agent?: string; user?: string; repo: string; branch: string; message: string; files?: PushFile[]; diff?: string }

export const SENSITIVE = [".github/*", ".circleci/*", ".gitlab-ci.yml", ".coderabbit.yaml", "scripts/*", "Dockerfile", "*/Dockerfile", ".husky/*", ".npmrc"];
const glob = (pat: string, s: string) => new RegExp("^" + pat.split("*").map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(s);

export interface PushAnalysis {
  verdict: "block" | "approve" | "allow"; reasons: string[];
  files: { path: string; removedComments: number; language: string }[]; gateChanges: GateChange[];
  sanitized: PushFile[]; secrets: SecretHit[]; score: number; scanModel: string;
}

export async function analysePush(req: PushRequest, pol: PushPolicy, checker: InjectionChecker, threshold: number, proposals: GateChange[] = []): Promise<PushAnalysis> {
  const reasons: string[] = []; let verdict: PushAnalysis["verdict"] = "allow";
  const block = (r: string) => { verdict = "block"; reasons.push(r); };
  const needApproval = (r: string) => { if (verdict !== "block") verdict = "approve"; reasons.push(r); };

  if (!req.repo || !req.branch || !req.message) block("A push needs a repo, a branch and a commit message");
  if (req.repo && !pol.repos.includes(req.repo)) block(`${req.repo} isn't on the list of repos agents may push to`);
  if (req.branch && !pol.branches.some(b => glob(b, req.branch))) block(`Branch ${req.branch} isn't allowed`);
  if (!req.files && req.diff) block("Send full files, not a diff: the gate can't clean a diff and never writes code itself");
  const input = (req.files ?? []).map(f => ({ path: f.path, content: f.content }));
  if (!input.length) block("The push has no files");
  if (input.length > (pol.maxFiles ?? 50)) block(`Too many files (${input.length})`);

  const guard = new GateActionGuard(pol.gateActions ?? ["delete_file", "remove_dependency", "strip_comments"]);
  const gateChanges: GateChange[] = [];
  const apply = (change: GateChange, before: PushFile, after: PushFile) => {
    const err = guard.verify(change, before, after);
    if (err) { block(err); return before; }
    gateChanges.push(change); return after;
  };
  const sanitized: PushFile[] = [], files: PushAnalysis["files"] = [];
  for (const f of input) {
    if (f.path.includes("..") || f.path.startsWith("/")) { block(`Unsafe file path ${f.path}`); continue; }
    if (f.content === null) { sanitized.push(f); files.push({ path: f.path, removedComments: 0, language: "deleted by agent" }); continue; }
    if (f.content.length > (pol.maxFileBytes ?? 200_000)) { block(`${f.path} is too large`); continue; }
    let cur: PushFile = f;
    const mine = proposals.filter(p => p.path === f.path);
    if ((pol.autoDeleteFiles ?? []).some(g => glob(g, f.path)) || mine.some(p => p.op === "delete_file")) {
      cur = apply({ op: "delete_file", path: f.path }, cur, { path: f.path, content: null });
      sanitized.push(cur); files.push({ path: f.path, removedComments: 0, language: "deleted by gate" }); continue;
    }
    if (/(^|\/)package\.json$/.test(f.path)) for (const dep of [...new Set([...(pol.removeDependencies ?? []), ...mine.filter(p => p.op === "remove_dependency" && p.detail).map(p => p.detail!)])]) {
      let next: string; try { next = removeDependency(cur.content!, dep); } catch { break; }
      if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(JSON.parse(cur.content!))) cur = apply({ op: "remove_dependency", path: f.path, detail: dep }, cur, { path: f.path, content: next });
    }
    const r = stripComments(f.path, cur.content!, { keepLicense: pol.keepLicenseHeaders, includeConfig: pol.stripConfigComments });
    if (r.content !== cur.content) cur = apply({ op: "strip_comments", path: f.path, detail: `${r.removed}` }, cur, { path: f.path, content: r.content });
    sanitized.push(cur);
    files.push({ path: f.path, removedComments: r.removed, language: r.language });
  }
  for (const p of proposals) if (!GATE_ACTIONS.includes(p.op as any)) block(`Agent proposed '${p.op}', which the gate can never do`);
  const secrets = input.flatMap(f => f.content === null ? [] : scanSecrets(f.path, f.content)).concat(scanSecrets("commit message", req.message ?? ""));
  if (secrets.length) block(`Possible secrets found: ${[...new Set(secrets.map(s => `${s.kind} in ${s.path}:${s.line}`))].slice(0, 5).join(", ")}`);

  const isOwner = req.agent === "owner";
  const sensitive = input.filter(f => SENSITIVE.some(g => glob(g, f.path)) || (/(^|\/)package\.json$/.test(f.path) && f.content !== null && /"scripts"\s*:/.test(f.content)));
  if (sensitive.length && !isOwner) needApproval(`Touches CI, workflows or package scripts (${sensitive.map(f => f.path).slice(0, 4).join(", ")}), so only the owner can sign this off`);
  const exempt = isOwner ? (pol.injectionExemptPaths ?? []) : [];
  const corpus = [`COMMIT MESSAGE: ${req.message}`, ...sanitized.filter(f => f.content !== null && !exempt.some(g => glob(g, f.path))).map(f => `FILE ${f.path}:\n${f.content}`)].join("\n\n").slice(0, 24_000);
  const check = await checker.check(corpus);
  if (check.score < threshold) block(`The code or text looks like a prompt-injection attempt (safety ${check.score}/100)`);

  if (pol.protectedBranches.includes(req.branch)) needApproval(`Pushes to ${req.branch} always need your sign-off`);
  if (pol.alwaysRequireApproval) needApproval("Every push needs your sign-off");
  if (verdict === "allow") reasons.push("Clean push to an allowed branch");
  return { verdict, reasons, files, gateChanges, sanitized, secrets, score: check.score, scanModel: check.model };
}

export function pushTicketText(id: string, req: PushRequest, a: PushAnalysis, time: string) {
  const removed = a.files.reduce((n, f) => n + f.removedComments, 0);
  return [`Push approval needed (ticket ${id})`,
    `${req.agent ?? "An agent"} wants to push ${a.files.length} file(s) to ${req.repo} on branch ${req.branch}.`,
    `Commit message: ${req.message.slice(0, 140)}`,
    `Files: ${a.files.map(f => f.path).slice(0, 6).join(", ")}${a.files.length > 6 ? ", ..." : ""}`,
    `Comments stripped: ${removed}. Safety score: ${a.score}/100.`,
    `Why it needs you: ${a.reasons.join(" ")}`,
    `Time: ${time}`].join("\n");
}
