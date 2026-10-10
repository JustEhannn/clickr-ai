# Clickr

The AI copilot that sees your screen. A floating macOS app (Tauri 2 + React/TypeScript + Rust) backed
by Supabase (auth, database, Edge Functions) and Stripe (billing). The website lives in a separate
repo (`getclickr`).

## Develop

```bash
npm install
npm run tauri dev        # the `clickr://` sign-in link and "open at login" only work in a built app
```

## Ship it

- **Publish an update / new download:** [RELEASING.md](RELEASING.md)
- **Everything still to do before and after launch:** [LAUNCH.md](LAUNCH.md)

## Layout

| Path | What it is |
|---|---|
| `src/` | The React UI: chat panel (`App.tsx`), Settings, sign-in, bug report, agent pill/cursor windows |
| `src-tauri/src/` | Rust: window management, screen capture, accessibility/agent control, auth, updates |
| `supabase/functions/` | Edge Functions: `ask` (AI gateway), `agent`, `stripe-webhook`, `app-auth-*`, `submit-bug-report` |
| `supabase/migrations/` | Database schema, applied in order |
| `scripts/` | `bump-version.sh`, `release.sh`, `rollback.sh` |
