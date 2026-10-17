import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CredentialStore {
  set(user: string, provider: string, secret: Record<string, string>): Promise<void>;
  get(user: string, provider: string): Promise<Record<string, string> | undefined>;
  list(user: string): Promise<string[]>;
  remove(user: string, provider: string): Promise<void>;
}

function masterKey(): Buffer {
  let k = process.env.DEPLOYBUG_MASTER_KEY;
  const f = process.env.DEPLOYBUG_MASTER_KEY_FILE ?? "/tmp/keys/master";
  if (!k && existsSync(f)) k = readFileSync(f, "utf8").trim();
  if (!k) { k = randomBytes(32).toString("hex"); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, k, { mode: 0o600 }); }
  return scryptSync(k, "deploybug-vault-v1", 32);
}

export class FileVault implements CredentialStore {
  private key = masterKey();
  constructor(private path = process.env.VAULT_FILE ?? "data/vault.json") {}
  private load(): Record<string, string> { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {}; }
  private save(d: Record<string, string>) { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(d, null, 1), { mode: 0o600 }); }
  private id(u: string, p: string) { return `${u}::${p}`; }
  async set(user: string, provider: string, secret: Record<string, string>) {
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(secret), "utf8"), c.final()]);
    const d = this.load(); d[this.id(user, provider)] = [iv, c.getAuthTag(), ct].map(b => b.toString("base64")).join("."); this.save(d);
  }
  async get(user: string, provider: string) {
    const v = this.load()[this.id(user, provider)]; if (!v) return;
    const [iv, tag, ct] = v.split(".").map(s => Buffer.from(s, "base64"));
    const d = createDecipheriv("aes-256-gcm", this.key, iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  }
  async list(user: string) { return Object.keys(this.load()).filter(k => k.startsWith(`${user}::`)).map(k => k.split("::")[1]); }
  async remove(user: string, provider: string) { const d = this.load(); delete d[this.id(user, provider)]; this.save(d); }
}

export interface Profile { timezone: string }
export function validTimezone(tz: string) { try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; } }
export function defaultTimezone() { const tz = process.env.DEFAULT_TZ ?? "Europe/London"; return validTimezone(tz) ? tz : "Europe/London"; }
export class ProfileStore {
  constructor(private path = process.env.PROFILE_FILE ?? "data/profiles.json") {}
  private load(): Record<string, Partial<Profile>> { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {}; }
  get(user: string): Profile { return { timezone: defaultTimezone(), ...this.load()[user] }; }
  set(user: string, patch: Partial<Profile>): Profile {
    if (patch.timezone !== undefined && !validTimezone(patch.timezone)) throw new Error(`unknown timezone '${patch.timezone}'`);
    const d = this.load(); d[user] = { ...d[user], ...patch };
    mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(d, null, 1));
    return this.get(user);
  }
}
