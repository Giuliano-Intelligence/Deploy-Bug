import { serve } from "@hono/node-server";
import { buildGate } from "./app.ts";

const { app, decide, notifier } = buildGate();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`deploybug gate on :${port}`));
if (notifier.enabled && process.env.TELEGRAM_POLL !== "0")
  notifier.poll(async (id, ok, cb) => { const r: any = await decide(id, ok); await notifier.answer(cb, r.status ?? r.error); });
