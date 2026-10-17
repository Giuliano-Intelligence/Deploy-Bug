import { signCommit, trailers, type FileState } from "@deploybug/policy";

export interface StageOps {
  headOf(branch: string): Promise<string>;
  createBranch(branch: string, sha: string): Promise<void>;
  commit(branch: string, files: FileState[], message: string): Promise<string>;
  guardConclusion(sha: string): Promise<"success" | "failure" | "pending">;
  fastForward(branch: string, sha: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
}

export interface StagedPush { repo: string; target: string; ticket: string; message: string; files: FileState[]; key: string; perFile?: boolean }

export const stageBranch = (target: string, ticket: string) => `deploybug/stage/${target}/${ticket}`;
export const signedMessage = (key: string, ticket: string, repo: string, target: string, message: string, files: FileState[]) =>
  message + trailers(ticket, signCommit(key, ticket, repo, target, files));

export async function stagedPush(ops: StageOps, p: StagedPush, wait = { tries: 120, ms: 5000 }) {
  const stage = stageBranch(p.target, p.ticket);
  await ops.createBranch(stage, await ops.headOf(p.target));
  let sha = "";
  try {
    const groups = p.perFile ? p.files.map(f => [f]) : [p.files];
    for (const g of groups) sha = await ops.commit(stage, g, signedMessage(p.key, p.ticket, p.repo, p.target, p.message, g));
    let state: "success" | "failure" | "pending" = "pending";
    for (let i = 0; i < wait.tries && state === "pending"; i++) { await new Promise(r => setTimeout(r, wait.ms)); state = await ops.guardConclusion(sha); }
    if (state !== "success") return { pushed: false, stage, sha, guard: state };
    await ops.fastForward(p.target, sha);
    await ops.deleteBranch(stage);
    return { pushed: true, stage, sha, guard: state };
  } catch (e) { return { pushed: false, stage, sha, guard: "error", error: String(e) }; }
}

const deepFind = (o: any, k: string): any => {
  if (!o || typeof o !== "object") return undefined;
  if (typeof o[k] === "string") return o[k];
  for (const v of Object.values(o)) { const r = deepFind(v, k); if (r) return r; }
};

export function composioStageOps(exec: (tool: string, args: Record<string, unknown>) => Promise<any>, repo: string): StageOps {
  const [owner, name] = repo.split("/");
  const base = { owner, repo: name };
  return {
    async headOf(branch) { const r = await exec("GITHUB_GET_A_BRANCH", { ...base, branch }); const s = deepFind(deepFind(r, "commit") ? r : r, "sha"); if (!s) throw new Error(`no head for ${branch}`); return s; },
    async createBranch(branch, sha) { await exec("GITHUB_CREATE_A_REFERENCE", { ...base, ref: `refs/heads/${branch}`, sha }); },
    async commit(branch, files, message) {
      let sha = "";
      for (const f of files) {
        const r = f.content === null
          ? await exec("GITHUB_DELETE_A_FILE", { ...base, path: f.path, branch, message, sha: deepFind(await exec("GITHUB_GET_REPOSITORY_CONTENT", { ...base, path: f.path, ref: branch }), "sha") })
          : await exec("GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", { ...base, path: f.path, branch, message, content: Buffer.from(f.content).toString("base64") });
        sha = deepFind(deepFind(r, "commit") ?? r, "sha") ?? sha;
      }
      if (!sha) sha = await this.headOf(branch);
      return sha;
    },
    async guardConclusion(sha) {
      const r = await exec("GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY", { ...base, head_sha: sha });
      const runs: any[] = deepFind({ r }, "workflow_runs") ?? r?.data?.workflow_runs ?? [];
      const run = runs.find(x => x.name === "deploybug-guard") ?? runs[0];
      if (!run || run.status !== "completed") return "pending";
      return run.conclusion === "success" ? "success" : "failure";
    },
    async fastForward(branch, sha) { await exec("GITHUB_UPDATE_A_REFERENCE", { ...base, ref: `heads/${branch}`, sha, force: false }); },
    async deleteBranch(branch) { await exec("GITHUB_DELETE_A_REFERENCE", { ...base, ref: `heads/${branch}` }); },
  };
}

export function gitStageOps(sh: (cmd: string, args: string[], input?: string) => string, repo: string): StageOps {
  return {
    async headOf(branch) { return sh("git", ["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s/)[0]; },
    async createBranch() {},
    async commit(branch, files, message) {
      sh("git", ["add", "-A", "--", ...files.map(f => f.path)]);
      sh("git", ["commit", "-F", "-"], message);
      sh("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
      return sh("git", ["rev-parse", "HEAD"]);
    },
    async guardConclusion(sha) {
      const out = sh("gh", ["run", "list", "-R", repo, "--commit", sha, "--workflow", "deploybug-guard", "--json", "status,conclusion", "-q", ".[0]|[.status,.conclusion]|@tsv"]);
      const [status, conclusion] = out.split("\t");
      if (status !== "completed") return "pending";
      return conclusion === "success" ? "success" : "failure";
    },
    async fastForward(branch) { sh("git", ["push", "origin", `HEAD:refs/heads/${branch}`]); },
    async deleteBranch(branch) { sh("git", ["push", "origin", "--delete", branch]); },
  };
}

export function appStageOps(api: (path: string, init?: RequestInit) => Promise<any>): StageOps {
  const post = (path: string, body: unknown, method = "POST") => api(path, { method, body: JSON.stringify(body) });
  return {
    async headOf(branch) { return (await api(`/git/ref/heads/${branch}`)).object.sha; },
    async createBranch(branch, sha) { await post("/git/refs", { ref: `refs/heads/${branch}`, sha }); },
    async commit(branch, files, message) {
      const parent = (await api(`/git/ref/heads/${branch}`)).object.sha;
      const baseTree = (await api(`/git/commits/${parent}`)).tree.sha;
      const tree = await post("/git/trees", { base_tree: baseTree, tree: files.map(f => f.content === null
        ? { path: f.path, mode: "100644", type: "blob", sha: null }
        : { path: f.path, mode: "100644", type: "blob", content: f.content }) });
      const c = await post("/git/commits", { message, tree: tree.sha, parents: [parent] });
      await post(`/git/refs/heads/${branch}`, { sha: c.sha, force: false }, "PATCH");
      return c.sha;
    },
    async guardConclusion(sha) {
      const r = await api(`/actions/runs?head_sha=${sha}`);
      const run = (r.workflow_runs ?? []).find((x: any) => x.name === "deploybug-guard");
      if (!run || run.status !== "completed") return "pending";
      return run.conclusion === "success" ? "success" : "failure";
    },
    async fastForward(branch, sha) { await post(`/git/refs/heads/${branch}`, { sha, force: false }, "PATCH"); },
    async deleteBranch(branch) { await api(`/git/refs/heads/${branch}`, { method: "DELETE" }); },
  };
}
