import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { scanSecrets } from "@deploybug/sanitize";

const allow = [/packages\/sanitize\/src\/index\.ts$/];
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
let hits = 0;
for (const f of files) {
  if (allow.some(r => r.test(f))) continue;
  let st; try { st = statSync(f); } catch { continue; }
  if (!st.isFile() || st.size > 2_000_000) continue;
  for (const h of scanSecrets(f, readFileSync(f, "utf8"))) { console.log(`possible ${h.kind}: ${h.path}:${h.line}`); hits++; }
}
console.log(`${hits} possible secret(s) in ${files.length} tracked file(s)`);
if (hits) process.exit(1);
