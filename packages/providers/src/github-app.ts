import { createSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

export interface AppConfig { appId: string; privateKey: string }

export function appConfig(): AppConfig | undefined {
  const appId = process.env.DEPLOYBUG_APP_ID;
  const f = process.env.DEPLOYBUG_APP_KEY_FILE ?? "/tmp/keys/deploybug_app.pem";
  if (!appId || !existsSync(f)) return undefined;
  return { appId, privateKey: readFileSync(f, "utf8") };
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function appJwt(cfg: AppConfig, now = Math.floor(Date.now() / 1000)) {
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64(sig)}`;
}

export class GitHubAppClient {
  private tokens = new Map<string, { token: string; exp: number }>();
  constructor(private cfg: AppConfig, private f: typeof fetch = fetch) {}
  private async call(path: string, auth: string, init: RequestInit = {}) {
    const r = await this.f(`https://api.github.com${path}`, { ...init, headers: { authorization: auth, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`github ${init.method ?? "GET"} ${path} ${r.status}`);
    return r.status === 204 ? undefined : r.json();
  }
  async installationToken(repo: string) {
    const c = this.tokens.get(repo);
    if (c && c.exp - Date.now() > 120_000) return c.token;
    const jwt = `Bearer ${appJwt(this.cfg)}`;
    const inst: any = await this.call(`/repos/${repo}/installation`, jwt);
    const t: any = await this.call(`/app/installations/${inst.id}/access_tokens`, jwt, { method: "POST", body: JSON.stringify({ repositories: [repo.split("/")[1]] }) });
    this.tokens.set(repo, { token: t.token, exp: Date.parse(t.expires_at) });
    return t.token as string;
  }
  async repoApi(repo: string, path: string, init: RequestInit = {}) {
    return this.call(`/repos/${repo}${path}`, `token ${await this.installationToken(repo)}`, init);
  }
}
