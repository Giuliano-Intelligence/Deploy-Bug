# Deploy Bug: build checklist (times in BST)

## Before 20:30: collect keys, build nothing
- [ ] Stripe account + Stripe CLI + projects plugin (`stripe projects --help` works), and `stripe whoami` ID noted
- [ ] CreateOS account + API token (createos.sh/app/profile) + CLI logged in
- [ ] RedPill API key (DeepSeek V4.1 Flash), OpenRouter key ($7)
- [ ] Composio account (free Hobby) + API key
- [ ] Telegram: BotFather bot token + your chat ID
- [ ] Mux token ID/secret + one anime video uploaded (playback ID)
- [ ] Stripe **test mode** restricted key (refunds write, charges read) + 2 test charges (£9, and one more)
- [ ] GitHub: new empty public repo `deploybug` + fine-grained token for that repo only
- [ ] Temporary X account (+ X API access if available, otherwise a mock intake)
- [ ] Hackathon code for the leaderboard
- [ ] Screen recorder ready (YouTube unlisted)

## Build
| Time | Task |
|---|---|
| 20:30–20:50 | `stripe projects init deploybug`, add Supabase (+ OpenRouter if it's in the catalog), `env --pull`. Push the skeleton repo, connect it to CreateOS deploy-from-GitHub |
| 20:50–21:30 | Bug Fix app (one page, Mux player, `brand.json`) live on its CreateOS URL |
| 21:30–22:15 | Gate API + checker (cheap score, escalation under 80, brand-diff, audit log to Supabase) |
| 22:15–23:00 | Worker: deepagents + CreateOS sandbox backend (`devbox:1`, egress allowlist, preview URL, destroy after). Write → test → fix loop |
| 23:00–23:30 | Telegram bot approvals + GitHub push on approve + auto-ship toggle |
| 23:30–23:55 | Refund guard (≤£20, once per customer, one charge) with the Stripe restricted key |
| 23:55–00:20 | X intake (or a mock tweet endpoint) + minimal dashboard |
| 00:20–00:45 | **Rehearse and record the demo** (3 beats) — recording done by 00:45 |
| 00:45–01:15 | README polish, `stripe projects share`, **submit by 01:15** (repo + live URL + share link + video) |
| 01:15–01:30 | Buffer |

## Cut list if behind
X intake → mock endpoint; dashboard → Telegram only; escalation model → single model.
Remember: the **free CreateOS plan runs one sandbox at a time**, so destroy each one after its task.

## Status 20:12 BST
- [x] TS monorepo, 7 tests passing
- [x] Gate live on CreateOS sandbox (s-1vcpu-1gb, free plan max)
- [ ] Stripe Projects onboarding (browser)
- [ ] Telegram: user presses Start
- [ ] Keys: REDPILL, OPENROUTER, COMPOSIO, MUX
