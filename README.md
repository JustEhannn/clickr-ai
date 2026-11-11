# Clickr AI

A free, open-source AI copilot for your Mac. A small floating window opens with a keyboard shortcut. Ask a question, and Clickr can look at your screen to answer. In Agent Mode it can click and type for you, with a visible cursor and an approval prompt for each action.

It runs on a **free open model on your own computer** through [Ollama](https://ollama.com). No account, no subscription, no server: nothing you ask or show it leaves your Mac.

## Get started

1. Download the latest `.dmg` from [Releases](https://github.com/JustEhannn/clickr/releases), drag **Clickr AI** to Applications, open it.
2. The first-run screen installs Ollama for you and lets you pick a model to download.
3. Press **⌘ ⇧ Space** anywhere to open Clickr. **⌘ ↵** asks it to look at your screen.

macOS may say the app is from an unidentified developer (it isn't notarized): open **System Settings → Privacy & Security → Open Anyway**. Clickr asks for **Screen Recording** (to see your screen) and, for Agent Mode, **Accessibility**.

## Models

Pick any of these in the app (sizes are download sizes; bigger is smarter but slower):

| Model | Size | Quality | Memory needed | Agent Mode |
|---|---|---|---|---|
| Qwen 3.8 27B | 18 GB | Best | 32 GB | yes |
| Gemma 4 31B | 20 GB | Excellent | 32 GB | yes |
| Gemma 4 26B | 17 GB | Excellent | 24 GB | yes |
| Qwen 3.5 9B | 6.6 GB | Very good | 16 GB | yes |
| Gemma 4 E4B | 6.6 GB | Very good | 16 GB | yes |
| Qwen 3 VL 8B | 6.2 GB | Good | 16 GB | yes |
| Qwen 3.5 4B | 3.4 GB | Good | 8 GB | yes |
| Gemma 3 4B | 3.4 GB | Decent | 8 GB | no |
| Qwen 3.5 2B | 1.9 GB | Basic | 8 GB | yes |

The list lives in [`src/models.ts`](src/models.ts). Ranking is by model generation and size, not a benchmark. Local models are weaker than cloud ones, and Agent Mode in particular works best with the larger models.

## Build from source

Needs macOS 14+, [Node 20+](https://nodejs.org), and [Rust](https://rustup.rs).

```bash
git clone https://github.com/JustEhannn/clickr.git
cd clickr
npm install
npm run tauri dev      # run it
npm run tauri build    # make the app and a .dmg
```

Maintainers: `scripts/bump-version.sh X.Y.Z`, then `PUBLISH=1 scripts/release.sh "notes"` builds a universal app and creates a GitHub release (needs `gh` and the update-signing key; the public key in `src-tauri/tauri.conf.json` is the project's).

## How it works

- **UI:** React + TypeScript (`src/`). `App.tsx` is the chat, `SetupAI.tsx` the first-run model setup, `SettingsApp.tsx` settings.
- **Native:** Rust + Tauri 2 (`src-tauri/src/`). `ollama.rs` installs/starts Ollama, downloads models and talks to the model; `agent.rs` runs Agent Mode; `platform/` has the macOS screen capture and Accessibility code; `local.rs` stores memories on disk.
- **Your data** stays in `~/Library/Application Support/net.getclickr.app` and the app's local storage.

## Contributing

Issues and pull requests are welcome. Windows support is not done yet: see [WINDOWS.md](WINDOWS.md). Please keep new native code behind `cfg` gates so macOS keeps working.

## License

[MIT](LICENSE)
