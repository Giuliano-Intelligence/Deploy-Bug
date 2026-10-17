import { createHash, createHmac } from "node:crypto";

export type GateActionKind = "delete_file" | "remove_dependency" | "strip_comments";
export const GATE_ACTIONS: readonly GateActionKind[] = ["delete_file", "remove_dependency", "strip_comments"];

export interface GateChange { op: string; path: string; detail?: string }
export interface FileState { path: string; content: string | null }

const squash = (s: string) => s.replace(/\s+/g, "");

function isSubsequence(small: string, big: string) {
  let i = 0;
  for (let j = 0; j < big.length && i < small.length; j++) if (big[j] === small[i]) i++;
  return i === small.length;
}

function onlyDependencyRemoved(before: string, after: string, dep: string) {
  try {
    const a = JSON.parse(before), b = JSON.parse(after);
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) if (a[k]) delete a[k][dep];
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}

export class GateActionGuard {
  constructor(private allowed: readonly string[] = GATE_ACTIONS) {
    for (const a of allowed) if (!GATE_ACTIONS.includes(a as GateActionKind)) throw new Error(`gate action '${a}' can never be enabled: the gate only deletes files, removes dependencies or strips comments`);
  }

  verify(change: GateChange, before: FileState, after: FileState): string | undefined {
    if (!this.allowed.includes(change.op)) return `Gate action '${change.op}' isn't allowed`;
    if (before.path !== change.path || after.path !== change.path) return `Gate change path mismatch for ${change.path}`;
    switch (change.op) {
      case "delete_file":
        return after.content === null ? undefined : `delete_file on ${change.path} left content behind`;
      case "remove_dependency":
        if (before.content === null || after.content === null || !change.detail) return "remove_dependency needs a package.json and a dependency name";
        return onlyDependencyRemoved(before.content, after.content, change.detail) ? undefined : `remove_dependency changed more than '${change.detail}' in ${change.path}`;
      case "strip_comments":
        if (before.content === null || after.content === null) return "strip_comments needs file content";
        return isSubsequence(squash(after.content), squash(before.content)) ? undefined : `strip_comments on ${change.path} added characters, so it was rejected`;
    }
    return `Unknown gate action '${change.op}'`;
  }
}

export function removeDependency(pkgJson: string, dep: string): string {
  const p = JSON.parse(pkgJson);
  for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) if (p[k]) delete p[k][dep];
  return JSON.stringify(p, null, 2) + "\n";
}

export function contentDigest(files: FileState[]): string {
  const lines = [...files].sort((a, b) => a.path.localeCompare(b.path))
    .map(f => `${f.path}\0${f.content === null ? "deleted" : createHash("sha256").update(f.content).digest("hex")}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function signCommit(key: string, ticket: string, repo: string, branch: string, files: FileState[]): string {
  return createHmac("sha256", key).update(`${ticket}:${repo}:${branch}:${contentDigest(files)}`).digest("hex");
}

export function trailers(ticket: string, sig: string) {
  return `\n\nDeploy-Bug-Approved: ${ticket}\nDeploy-Bug-Signature: ${sig}`;
}
