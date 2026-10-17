import { execFileSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const key = process.env.DEPLOYBUG_SIGNING_KEY ?? "";
const repo = process.env.GITHUB_REPOSITORY ?? "";
const ref = process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME || "";
const branch = ref.match(/^deploybug\/stage\/(.+)\/[^/]+$/)?.[1] ?? ref;
const [from, to] = [process.env.RANGE_FROM ?? "", process.env.RANGE_TO ?? "HEAD"];

if (!key && process.env.GITHUB_EVENT_NAME === "pull_request") {
  console.log("::error::DEPLOYBUG_SIGNING_KEY is not available to this pull_request run, so commits cannot be verified");
  process.exit(1);
}
if (!key) {
  console.log("::warning::DEPLOYBUG_SIGNING_KEY is not set, so commit signatures are not enforced (bootstrap mode). Add the repo secret to enforce.");
  process.exit(0);
}

const zero = /^0+$/.test(from) || !from;
const shas = (zero ? [to] : git("rev-list", "--no-merges", `${from}..${to}`).split("\n").filter(Boolean));
let bad = 0;
for (const sha of shas) {
  const msg = git("log", "-1", "--format=%B", sha);
  const ticket = msg.match(/^Deploy-Bug-Approved: (\S+)$/m)?.[1];
  const sig = msg.match(/^Deploy-Bug-Signature: ([0-9a-f]{64})$/m)?.[1];
  if (!ticket || !sig) { console.log(`::error::${sha.slice(0, 7)} did not come through Deploy Bug (missing Deploy-Bug-Approved trailer)`); bad++; continue; }
  const changed = git("diff-tree", "--no-commit-id", "--name-status", "-r", "--root", sha).split("\n").filter(Boolean).map(l => l.split("\t"));
  const files = changed.map(([status, path]) => {
    if (status.startsWith("D")) return { path, content: null };
    return { path, content: execFileSync("git", ["show", `${sha}:${path}`]) };
  });
  const lines = files.sort((a, b) => a.path.localeCompare(b.path))
    .map(f => `${f.path}\0${f.content === null ? "deleted" : createHash("sha256").update(f.content).digest("hex")}`);
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  const want = createHmac("sha256", key).update(`${ticket}:${repo}:${branch}:${digest}`).digest("hex");
  if (!timingSafeEqual(Buffer.from(want), Buffer.from(sig))) { console.log(`::error::${sha.slice(0, 7)} has an invalid Deploy Bug signature (ticket ${ticket})`); bad++; }
  else console.log(`ok ${sha.slice(0, 7)} ticket ${ticket}`);
}
if (bad) process.exit(1);
console.log(`${shas.length} commit(s) verified`);
