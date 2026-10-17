import { GateActionGuard, signCommit, type FileState, type GateChange } from "@deploybug/policy";
import { safeEq } from "./auth.ts";
import { stagedPush, type StageOps } from "./stage.ts";

export interface RollbackSource {
  commits(branch: string, n: number): Promise<{ sha: string; message: string }[]>;
  guardGreen(sha: string): Promise<boolean>;
  changedPaths(from: string, to: string): Promise<string[]>;
  fileAt(sha: string, path: string): Promise<string | null>;
  commitFiles(sha: string): Promise<FileState[]>;
}

export type Verify = (sha: string, message: string) => Promise<boolean>;
export const hmacVerifier = (src: RollbackSource, key: string, repo: string, branch: string): Verify => async (sha, message) => {
  const ticket = message.match(/^Deploy-Bug-Approved: (\S+)$/m)?.[1];
  const sig = message.match(/^Deploy-Bug-Signature: ([0-9a-f]{64})$/m)?.[1];
  if (!ticket || !sig || !key) return false;
  return safeEq(signCommit(key, ticket, repo, branch, await src.commitFiles(sha)), sig);
};

const signed = (m: string) => /^Deploy-Bug-Approved: \S+$/m.test(m) && /^Deploy-Bug-Signature: [0-9a-f]{64}$/m.test(m);

export async function findGood(src: RollbackSource, branch: string, to: string | undefined, verify: Verify) {
  const list = await src.commits(branch, 30);
  if (!list.length) throw new Error(`${branch} has no commits`);
  const head = list[0].sha;
  for (const c of list.slice(1)) {
    if (to && !c.sha.startsWith(to)) continue;
    if (signed(c.message) && await verify(c.sha, c.message) && await src.guardGreen(c.sha)) return { head, good: c.sha };
    if (to) throw new Error(`${to} is not a gate-signed commit with a green guard run`);
  }
  throw new Error("no earlier gate-signed commit with a green guard run");
}

export async function planRollback(src: RollbackSource, branch: string, to: string | undefined, verify: Verify) {
  const { head, good } = await findGood(src, branch, to, verify);
  const paths = await src.changedPaths(good, head);
  const guard = new GateActionGuard();
  const files: FileState[] = [], changes: GateChange[] = [];
  for (const path of paths) {
    const before = { path, content: await src.fileAt(head, path) };
    const prior = { path, content: await src.fileAt(good, path) };
    const after = { path, content: prior.content };
    const change = { op: "restore", path, detail: good };
    const err = guard.verify(change, before, after, prior);
    if (err) throw new Error(err);
    files.push(after); changes.push(change);
  }
  return { head, good, files, changes };
}

export async function runRollback(src: RollbackSource, ops: StageOps, p: { repo: string; branch: string; ticket: string; key: string; to?: string }, redeploy?: () => Promise<unknown>, wait?: { tries: number; ms: number }) {
  const plan = await planRollback(src, p.branch, p.to, hmacVerifier(src, p.key, p.repo, p.branch));
  if (!plan.files.length) return { pushed: false, reason: "nothing to roll back", ...plan };
  const message = `Revert ${p.branch} to ${plan.good.slice(0, 7)}\n\nRestores the gate-signed state of ${plan.good} (reverting ${plan.head.slice(0, 7)}).`;
  const r = await stagedPush(ops, { repo: p.repo, target: p.branch, ticket: p.ticket, message, files: plan.files, key: p.key }, wait);
  const deployed = r.pushed && redeploy ? await redeploy().then(x => ({ ok: true, x }), e => ({ ok: false, error: String(e) })) : undefined;
  return { ...r, good: plan.good, head: plan.head, restored: plan.files.map(f => f.path), redeploy: deployed };
}

export function appRollbackSource(api: (path: string, init?: RequestInit) => Promise<any>): RollbackSource {
  return {
    async commits(branch, n) { return ((await api(`/commits?sha=${encodeURIComponent(branch)}&per_page=${n}`)) as any[]).map(c => ({ sha: c.sha, message: c.commit.message })); },
    async guardGreen(sha) { return ((await api(`/actions/runs?head_sha=${sha}`)).workflow_runs ?? []).some((r: any) => r.name === "deploybug-guard" && r.conclusion === "success"); },
    async changedPaths(from, to) { return ((await api(`/compare/${from}...${to}`)).files ?? []).flatMap((f: any) => f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]); },
    async commitFiles(sha) {
      const c = await api(`/commits/${sha}`);
      const out: FileState[] = [];
      for (const f of c.files ?? []) {
        if (f.status === "removed") out.push({ path: f.filename, content: null });
        else { out.push({ path: f.filename, content: await this.fileAt(sha, f.filename) }); if (f.previous_filename) out.push({ path: f.previous_filename, content: null }); }
      }
      return out;
    },
    async fileAt(sha, path) {
      try { const r = await api(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`); return Buffer.from(r.content, "base64").toString("utf8"); }
      catch (e) { if (/ 404$/.test(String((e as Error).message))) return null; throw e; }
    },
  };
}
