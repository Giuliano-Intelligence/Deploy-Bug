import { readFileSync } from "node:fs";
import { FileVault } from "@deploybug/vault";
const [user, provider, file] = process.argv.slice(2);
await new FileVault().set(user, provider, { apiKey: readFileSync(file, "utf8").trim() });
console.log(`stored ${user}/${provider}`);
