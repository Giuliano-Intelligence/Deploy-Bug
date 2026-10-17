import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "@deploybug/sanitize";

const args = process.argv.slice(2);
const check = args.includes("--check"), keepLicense = !args.includes("--drop-license"), includeConfig = args.includes("--include-config");
const root = args.find(a => !a.startsWith("--")) ?? ".";
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".projects", ".agents", ".claude", ".cursor", "data", ".next", "coverage"]);
const IGNORE_FILE = ".stripignore";
let ignore: string[] = [];
try { ignore = readFileSync(join(root, IGNORE_FILE), "utf8").split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#")); } catch {}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (ignore.some(i => relative(root, p).startsWith(i))) continue;
    if (statSync(p).isDirectory()) yield* walk(p); else yield p;
  }
}

let dirty = 0, files = 0;
for (const p of walk(root)) {
  const src = readFileSync(p, "utf8");
  const r = stripComments(p, src, { keepLicense, includeConfig });
  if (!r.supported || r.content === src) continue;
  files++; dirty += r.removed;
  if (check) console.log(`comments found: ${relative(root, p)} (${r.removed})`);
  else { writeFileSync(p, r.content); console.log(`stripped ${relative(root, p)} (${r.removed})`); }
}
console.log(check ? `${files} file(s) with comments` : `stripped ${dirty} comment(s) in ${files} file(s)`);
if (check && files) process.exit(1);
