import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadPolicies, signCommit, trailers } from "@deploybug/policy";
import { InjectionChecker, loadModels, resolveProvider } from "@deploybug/checker";
import { reviewPush } from "@deploybug/workers";
import { analysePush } from "../apps/gate/src/push.ts";

const sh = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 }).trim();
const [repo, target, ...msgParts] = process.argv.slice(2);
const message = msgParts.join(" ");
if (!repo || !target || !message) { console.error("usage: gate-push <owner/repo> <branch> <message>"); process.exit(2); }
if (!process.env.APPROVED_BY) { console.error("APPROVED_BY is required: pushes to protected branches need the owner's sign-off"); process.exit(2); }

const paths = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { encoding: "utf8" }).split("\0").filter(Boolean).map(l => l.slice(3));
const files = paths.map(p => ({ path: p, content: existsSync(p) ? readFileSync(p, "utf8") : null }));
const models = loadModels();
const pol = (loadPolicies() as any).push;
const rp = resolveProvider(models, models.brain.provider);
const review = await reviewPush(rp.key && rp.base ? { model: models.brain.model, key: rp.key, base: rp.base } : undefined, files, message);
const a = await analysePush({ agent: "gate-push", repo, branch: target, message, files }, pol, new InjectionChecker(models), models.escalateBelow, review.proposals);
console.log(JSON.stringify({ agent: review.summary.slice(0, 300), verdict: a.verdict, reasons: a.reasons, gateChanges: a.gateChanges, score: a.score }, null, 1));
if (a.verdict === "block") process.exit(1);

for (const f of a.sanitized) { if (f.content === null) rmSync(f.path, { force: true }); else writeFileSync(f.path, f.content); }
const ticket = `${process.env.APPROVED_BY}-${randomUUID().slice(0, 8)}`;
const key = (process.env.DEPLOYBUG_SIGNING_KEY ?? readFileSync(process.env.DEPLOYBUG_SIGNING_KEY_FILE ?? "/tmp/keys/deploybug_signing", "utf8")).trim();
sh("git", ["add", "-A", "--", ...a.sanitized.map(f => f.path)]);
sh("git", ["commit", "-F", "-"], message + trailers(ticket, signCommit(key, ticket, repo, target, a.sanitized)));
const sha = sh("git", ["rev-parse", "HEAD"]);
const stage = `deploybug/stage/${target}/${ticket}`;
sh("git", ["push", "origin", `HEAD:refs/heads/${stage}`]);
console.log(`staged ${sha.slice(0, 7)} on ${stage}, waiting for guard`);
let run = "";
for (let i = 0; i < 30 && !run; i++) { await new Promise(r => setTimeout(r, 5000)); run = sh("gh", ["run", "list", "-R", repo, "--commit", sha, "--json", "databaseId", "-q", ".[0].databaseId"]); }
if (!run) { console.error("guard run never started"); process.exit(1); }
try { sh("gh", ["run", "watch", run, "-R", repo, "--exit-status"]); } catch { console.error(`guard failed: https://github.com/${repo}/actions/runs/${run}`); process.exit(1); }
sh("git", ["push", "origin", `HEAD:refs/heads/${target}`]);
sh("git", ["push", "origin", "--delete", stage]);
console.log(`pushed ${sha.slice(0, 7)} to ${target} (ticket ${ticket})`);
