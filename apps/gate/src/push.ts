import { stripComments, scanSecrets, type SecretHit } from "@deploybug/sanitize";
import type { InjectionChecker } from "@deploybug/checker";

export interface PushPolicy { repos: string[]; branches: string[]; protectedBranches: string[]; alwaysRequireApproval?: boolean; keepLicenseHeaders?: boolean; stripConfigComments?: boolean; maxFiles?: number; maxFileBytes?: number }
export interface PushFile { path: string; content: string }
export interface PushRequest { agent?: string; user?: string; repo: string; branch: string; message: string; files?: PushFile[]; diff?: string }

const glob = (pat: string, s: string) => new RegExp("^" + pat.split("*").map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(s);

export function parseDiff(diff: string): PushFile[] {
  const files: PushFile[] = []; let cur: PushFile | undefined;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { cur = { path: l.slice(4).replace(/^b\//, ""), content: "" }; files.push(cur); }
    else if (cur && l.startsWith("+") && !l.startsWith("+++")) cur.content += l.slice(1) + "\n";
  }
  return files;
}

export interface PushAnalysis {
  verdict: "block" | "approve" | "allow"; reasons: string[];
  files: { path: string; removedComments: number; language: string }[];
  sanitized: PushFile[]; secrets: SecretHit[]; score: number; scanModel: string;
}

export async function analysePush(req: PushRequest, pol: PushPolicy, checker: InjectionChecker, threshold: number): Promise<PushAnalysis> {
  const reasons: string[] = []; let verdict: PushAnalysis["verdict"] = "allow";
  const block = (r: string) => { verdict = "block"; reasons.push(r); };
  const needApproval = (r: string) => { if (verdict !== "block") verdict = "approve"; reasons.push(r); };

  if (!req.repo || !req.branch || !req.message) block("A push needs a repo, a branch and a commit message");
  if (req.repo && !pol.repos.includes(req.repo)) block(`${req.repo} isn't on the list of repos agents may push to`);
  if (req.branch && !pol.branches.some(b => glob(b, req.branch))) block(`Branch ${req.branch} isn't allowed`);
  const isDiff = !req.files && !!req.diff;
  const input = req.files ?? (req.diff ? parseDiff(req.diff) : []);
  if (!input.length) block("The push has no files");
  if (input.length > (pol.maxFiles ?? 50)) block(`Too many files (${input.length})`);

  const sanitized: PushFile[] = [], files: PushAnalysis["files"] = [];
  for (const f of input) {
    if (f.path.includes("..") || f.path.startsWith("/")) { block(`Unsafe file path ${f.path}`); continue; }
    if (f.content.length > (pol.maxFileBytes ?? 200_000)) { block(`${f.path} is too large`); continue; }
    const r = isDiff ? { content: f.content, removed: 0, language: "diff" } : stripComments(f.path, f.content, { keepLicense: pol.keepLicenseHeaders, includeConfig: pol.stripConfigComments });
    sanitized.push({ path: f.path, content: r.content });
    files.push({ path: f.path, removedComments: r.removed, language: r.language });
  }
  const secrets = input.flatMap(f => scanSecrets(f.path, f.content)).concat(scanSecrets("commit message", req.message ?? ""));
  if (secrets.length) block(`Possible secrets found: ${[...new Set(secrets.map(s => `${s.kind} in ${s.path}:${s.line}`))].slice(0, 5).join(", ")}`);

  const corpus = [`COMMIT MESSAGE: ${req.message}`, ...sanitized.map(f => `FILE ${f.path}:\n${f.content}`)].join("\n\n").slice(0, 24_000);
  const check = await checker.check(corpus);
  if (check.score < threshold) block(`The code or text looks like a prompt-injection attempt (safety ${check.score}/100)`);

  if (pol.protectedBranches.includes(req.branch)) needApproval(`Pushes to ${req.branch} always need your sign-off`);
  if (isDiff) needApproval("Raw diffs can't be cleaned automatically, so they need your sign-off");
  if (pol.alwaysRequireApproval) needApproval("Every push needs your sign-off");
  if (verdict === "allow") reasons.push("Clean push to an allowed branch");
  return { verdict, reasons, files, sanitized, secrets, score: check.score, scanModel: check.model };
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
