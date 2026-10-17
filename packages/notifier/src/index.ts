import { readFileSync, existsSync } from "node:fs";

export interface Ticket { id: string; summary: string; createdAt: number; status: "pending" | "approved" | "denied"; payload: any }

export function telegramToken(): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const f = process.env.TELEGRAM_TOKEN_FILE ?? "/tmp/keys/telegram";
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
}

export class TelegramNotifier {
  private api?: string;
  constructor(private chatId = process.env.TELEGRAM_CHAT_ID) {
    const t = telegramToken(); if (t) this.api = `https://api.telegram.org/bot${t}`;
  }
  get enabled() { return Boolean(this.api && this.chatId); }

  async discoverChatId(): Promise<string | undefined> {
    if (!this.api) return;
    const j: any = await (await fetch(`${this.api}/getUpdates`)).json();
    const id = j.result?.map((u: any) => u.message?.chat?.id ?? u.callback_query?.message?.chat?.id).find(Boolean);
    if (id) this.chatId = String(id);
    return this.chatId;
  }

  async sendApproval(t: Ticket, text = t.summary) {
    if (!this.enabled) return { skipped: true };
    return (await fetch(`${this.api}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text,
        reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `approve:${t.id}` }, { text: "❌ Deny", callback_data: `deny:${t.id}` }]] } }) })).json();
  }

  async sendAlert(text: string) {
    const tok = process.env.TELEGRAM_ALERT_TOKEN;
    const api = tok ? `https://api.telegram.org/bot${tok}` : this.api;
    const chat = process.env.TELEGRAM_ALERT_CHAT_ID ?? this.chatId;
    if (!api || !chat) return { skipped: true };
    return (await fetch(`${api}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(10_000) })).json();
  }

  async answer(callbackId: string, text: string) {
    if (!this.api) return;
    await fetch(`${this.api}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: callbackId, text }) });
  }

  async poll(onDecision: (id: string, approve: boolean, cbId: string) => Promise<void>) {
    if (!this.api) return;
    let offset = 0;
    for (;;) {
      try {
        const j: any = await (await fetch(`${this.api}/getUpdates?timeout=25&offset=${offset}&allowed_updates=["callback_query"]`)).json();
        for (const u of j.result ?? []) {
          offset = u.update_id + 1;
          const d: string | undefined = u.callback_query?.data;
          if (d) { const [act, id] = d.split(":"); await onDecision(id, act === "approve", u.callback_query.id); }
        }
      } catch { await new Promise(r => setTimeout(r, 3000)); }
    }
  }
}
