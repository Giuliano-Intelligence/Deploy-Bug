import ts from "typescript";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

export interface StripOptions { keepLicense?: boolean; includeConfig?: boolean }
export interface StripResult { content: string; removed: number; language: string; supported: boolean; error?: string }

const TS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const HASH_EXT = new Set([".sh", ".bash"]);
const CONFIG_EXT = new Set([".yaml", ".yml", ".toml"]);
const LICENSE = /(license|copyright|spdx-license-identifier)/i;

function kindFor(ext: string) {
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(ext)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function removeRanges(src: string, ranges: { pos: number; end: number }[]) {
  ranges.sort((a, b) => b.pos - a.pos);
  const lineOf = (i: number) => src.lastIndexOf("\n", i - 1) + 1;
  let out = src;
  const emptied = new Set<number>();
  for (const r of ranges) {
    const ls = lineOf(r.pos);
    let le = out.indexOf("\n", r.end); if (le === -1) le = out.length;
    const before = out.slice(ls, r.pos), after = out.slice(r.end, le);
    if (!before.trim() && !after.trim()) {
      out = out.slice(0, ls) + out.slice(le === out.length ? le : le + 1);
      emptied.add(ls);
    } else {
      out = out.slice(0, r.pos).replace(/[ \t]+$/, "") + (after.trim() ? (before.trim() ? " " : "") : "") + out.slice(r.end).replace(/^[ \t]+/, after.trim() ? "" : "");
    }
  }
  return out.replace(/\n{3,}/g, "\n\n");
}

export function stripTsJs(src: string, ext: string, opts: StripOptions = {}): StripResult {
  const sf = ts.createSourceFile("f" + ext, src, ts.ScriptTarget.Latest, true, kindFor(ext));
  const seen = new Map<number, { pos: number; end: number }>();
  const shebang = src.startsWith("#!") ? src.indexOf("\n") : -1;
  const jsx: [number, number][] = [];
  const findJsx = (n: ts.Node) => { if (n.kind === ts.SyntaxKind.JsxText) jsx.push([n.pos, n.end]); n.forEachChild(findJsx); };
  findJsx(sf);
  const inJsx = (p: number) => jsx.some(([a, b]) => p >= a && p < b);
  const collect = (pos: number) => {
    if (inJsx(pos)) return;
    for (const r of [...(ts.getLeadingCommentRanges(src, pos) ?? []), ...(ts.getTrailingCommentRanges(src, pos) ?? [])]) {
      if (r.pos <= shebang || inJsx(r.pos)) continue;
      const text = src.slice(r.pos, r.end);
      if (opts.keepLicense && (text.startsWith("/*!") || (r.pos < 400 && LICENSE.test(text)))) continue;
      seen.set(r.pos, { pos: r.pos, end: r.end });
    }
  };
  const visit = (n: ts.Node) => {
    if (n.kind === ts.SyntaxKind.JsxText) return;
    collect(n.pos); collect(n.end);
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(sf);
  const ranges = [...seen.values()];
  return { content: ranges.length ? removeRanges(src, ranges) : src, removed: ranges.length, language: "ts/js", supported: true };
}

const PY_HELPER = join(dirname(fileURLToPath(import.meta.url)), "strip_py.py");
export function stripPython(src: string, opts: StripOptions = {}): StripResult {
  const r = spawnSync("python3", [PY_HELPER, opts.keepLicense ? "keep" : "drop"], { input: src, encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return { content: src, removed: 0, language: "python", supported: true, error: (r.stderr || "python3 failed").slice(0, 200) };
  const removed = src.split("\n").length - r.stdout.split("\n").length + (src === r.stdout ? 0 : 0);
  return { content: r.stdout, removed: src === r.stdout ? 0 : Math.max(1, removed), language: "python", supported: true };
}

export function stripHashLines(src: string, opts: StripOptions = {}): StripResult {
  let removed = 0;
  const out = src.split("\n").filter((l, i) => {
    if (i === 0 && l.startsWith("#!")) return true;
    if (/^\s*#/.test(l)) { if (opts.keepLicense && i < 5 && LICENSE.test(l)) return true; removed++; return false; }
    return true;
  }).join("\n");
  return { content: out, removed, language: "hash-comments (full lines only)", supported: true };
}

export function stripComments(path: string, src: string, opts: StripOptions = {}): StripResult {
  const ext = extname(path).toLowerCase();
  if (TS_EXT.has(ext)) return stripTsJs(src, ext, opts);
  if (ext === ".py") return stripPython(src, opts);
  if (HASH_EXT.has(ext) || (opts.includeConfig && CONFIG_EXT.has(ext))) return stripHashLines(src, opts);
  return { content: src, removed: 0, language: ext || "none", supported: false };
}

export interface SecretHit { path: string; line: number; kind: string }
const SECRET_PATTERNS: [string, RegExp][] = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}/],
  ["Stripe key", /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/],
  ["Composio key", /\b(ck|ak|uak)_[A-Za-z0-9_-]{16,}\b/],
  ["Slack token", /\bxox[abpors]-[A-Za-z0-9-]{10,}/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["OpenAI/OpenRouter key", /\bsk-(or-v1-|proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["Generic secret assignment", /\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*["'][A-Za-z0-9_\-\/+=]{20,}["']/i],
];
export function scanSecrets(path: string, src: string): SecretHit[] {
  const hits: SecretHit[] = [];
  src.split("\n").forEach((l, i) => { for (const [kind, re] of SECRET_PATTERNS) if (re.test(l)) hits.push({ path, line: i + 1, kind }); });
  return hits;
}
