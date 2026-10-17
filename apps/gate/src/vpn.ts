import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface VpnOptions { file?: string; cidrs?: string[]; configFile?: string; ipOf?: (c: any) => string | undefined }

const toInt = (ip: string) => ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
export function inCidr(ip: string, cidr: string) {
  const v4 = ip.replace(/^::ffff:/, "");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return false;
  const [base, bits] = cidr.split("/"); const b = Number(bits ?? 32);
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return (toInt(v4) & mask) === (toInt(base) & mask);
}

export class VpnMode {
  private file: string; private cidrs: string[]; private configFile: string; private ipOf: (c: any) => string | undefined;
  constructor(o: VpnOptions = {}) {
    this.file = o.file ?? process.env.VPN_STATE_FILE ?? "data/vpn.json";
    this.cidrs = o.cidrs ?? (process.env.VPN_CIDRS ?? "10.0.0.0/8,100.64.0.0/10").split(",").map(s => s.trim()).filter(Boolean);
    this.configFile = o.configFile ?? process.env.VPN_PEER_CONFIG ?? "/tmp/keys/wg-phone.conf";
    this.ipOf = o.ipOf ?? (c => c.env?.incoming?.socket?.remoteAddress);
  }
  get enabled() {
    if (process.env.VPN_FORCE_OFF === "1") return false;
    try { return JSON.parse(readFileSync(this.file, "utf8")).enabled === true; } catch { return false; }
  }
  set(enabled: boolean) { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ enabled, at: new Date().toISOString() })); return this.status(); }
  status() { return { enabled: this.enabled, cidrs: this.cidrs, peerConfig: existsSync(this.configFile) }; }
  allows(c: any) {
    if (!this.enabled) return true;
    if (c.req.header("x-forwarded-for")) return false;
    const ip = this.ipOf(c);
    return !!ip && this.cidrs.some(r => inCidr(ip, r));
  }
  async peer() {
    if (!existsSync(this.configFile)) return undefined;
    const config = readFileSync(this.configFile, "utf8");
    const QR = await import("qrcode");
    return { config, qrSvg: await QR.toString(config, { type: "svg", errorCorrectionLevel: "M" }) };
  }
}
