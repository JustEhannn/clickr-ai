<p align="center">
  <img src="src/assets/clickr-logo-transparent.png" alt="Clickr AI" width="120" />
</p>

<h1 align="center">Clickr AI</h1>

<p align="center">
  <a href="https://github.com/JustEhannn/clickr-ai/blob/main/LICENSE"><img src="https://img.shields.io/github/license/JustEhannn/clickr-ai?style=flat" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey?style=flat" alt="Platform" />
  <a href="https://github.com/JustEhannn/clickr-ai/releases/latest"><img src="https://img.shields.io/github/v/release/JustEhannn/clickr-ai?style=flat&sort=semver" alt="GitHub release" /></a>
  <a href="https://github.com/JustEhannn/clickr-ai/releases"><img src="https://img.shields.io/github/downloads/JustEhannn/clickr-ai/total?style=flat&color=blue" alt="Downloads" /></a>
  <a href="https://github.com/JustEhannn/clickr-ai/stargazers"><img src="https://img.shields.io/github/stars/JustEhannn/clickr-ai?style=flat" alt="GitHub stars" /></a>
</p>

<p align="center">
  The free and open-source AI copilot for your Mac.<br/>
  Ask about anything on your screen, analyze files, and let Agent Mode do tasks for you. Runs on a local model, so nothing leaves your computer.
</p>

<p align="center">
  <a href="https://www.clickrai.com">Website</a> &middot;
  <a href="https://github.com/JustEhannn/clickr-ai/releases/latest">Download</a> &middot;
  <a href="https://github.com/JustEhannn/clickr-ai/issues">Issues</a> &middot;
  <a href="WINDOWS.md">Windows port</a>
</p>

---

Clickr AI is a small floating window that opens with a keyboard shortcut. Ask a question and it can look at your screen to answer. In Agent Mode it clicks and types for you, with its own visible cursor and an approval prompt for each action. It runs a free open model right inside the app, on your own computer: no account, no subscription, no server, no telemetry. Everything you ask or show it stays on your Mac.

## Download

| Platform                    | Download                                                                  |
| --------------------------- | ------------------------------------------------------------------------- |
| macOS (Apple Silicon, Intel) | [`.dmg`](https://github.com/JustEhannn/clickr-ai/releases/latest/download/Clickr-AI.dmg) |
| Windows                     | Coming soon: see [WINDOWS.md](WINDOWS.md)                                 |

Requires macOS 14 or later. The app isn't notarized yet, so macOS may say it's from an unidentified developer: open **System Settings → Privacy & Security → Open Anyway**. Clickr asks for **Screen Recording** (to see your screen) and, for Agent Mode, **Accessibility**.

## Features

- **Ask about your screen**: global hotkey (`⌘ ⇧ Space`) opens Clickr anywhere; **Assist** (`⌘ ↵`) looks at your screen first and helps
- **Agent Mode**: Clickr clicks, types, opens apps and manages files for you, with its own on-screen cursor, an approval prompt for each action, and a Stop button
- **Free local AI**: a first-run step downloads the model you pick, from tiny and fast to large and strong, plus a small built-in engine (llama.cpp). No other app to install or keep open (see [Models](#models))
- **Files and images**: drop in images, PDFs-as-text, code and text files to ask about them
- **Memory**: type "remember …" and Clickr keeps it on your computer for later chats
- **App-aware and multi-monitor**: knows which app you're in and can capture any display
- **Conversation history**: search, reopen and delete past chats, stored locally
- **Private by design**: no accounts, no tracking, no data leaves your Mac
- **Free forever**: every feature is included, MIT licensed

## Models

Pick any of these in the app (sizes are download sizes; bigger is smarter but slower):

| Model         | Size   | Quality   | Memory needed | Agent Mode |
| ------------- | ------ | --------- | ------------- | ---------- |
| Qwen 3.8 27B  | 18 GB  | Best      | 32 GB         | yes        |
| Gemma 4 31B   | 20 GB  | Excellent | 32 GB         | yes        |
| Gemma 4 26B   | 17 GB  | Excellent | 24 GB         | yes        |
| Qwen 3.5 9B   | 6.6 GB | Very good | 16 GB         | yes        |
| Gemma 4 E4B   | 6.6 GB | Very good | 16 GB         | yes        |
| Qwen 3 VL 8B  | 6.2 GB | Good      | 16 GB         | yes        |
| Qwen 3.5 4B   | 3.4 GB | Good      | 8 GB          | yes        |
| Gemma 3 4B    | 3.4 GB | Decent    | 8 GB          | no         |
| Qwen 3.5 2B   | 1.9 GB | Basic     | 8 GB          | yes        |

The list lives in [`src/models.ts`](src/models.ts). Ranking is by model generation and size, not a benchmark. Local models are weaker than cloud ones, and Agent Mode works best with the larger models.

## Quick start

```bash
git clone https://github.com/JustEhannn/clickr-ai.git
cd clickr-ai
npm install
npm run tauri dev      # run it
npm run tauri build    # make the app and a .dmg
```

Requires macOS 14+, [Node.js 20+](https://nodejs.org) and [Rust](https://rustup.rs).

Maintainers: `scripts/bump-version.sh X.Y.Z`, then `PUBLISH=1 scripts/release.sh "notes"` builds a universal app and creates a GitHub release. It needs `gh` and the update-signing key at `~/clickr-keys/clickr-updater.key`; the public key in `src-tauri/tauri.conf.json` is the project's.

## How it works

- **UI**: React + TypeScript in [`src/`](src/). `App.tsx` is the chat, `SetupAI.tsx` the first-run model setup, `SettingsApp.tsx` the settings.
- **Native**: Rust + Tauri 2 in [`src-tauri/src/`](src-tauri/src/). `engine.rs` downloads the llama.cpp engine and models from Hugging Face, runs the engine when you ask something, and talks to the model; `agent.rs` runs Agent Mode; `platform/` holds the macOS screen-capture and Accessibility code; `local.rs` stores memories on disk.
- **Your data** stays in `~/Library/Application Support/net.getclickr.app` and the app's local storage.

## Tech stack

React 19, TypeScript, Vite, Tauri 2, Rust, llama.cpp, ScreenCaptureKit

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=JustEhannn/clickr-ai&type=date&legend=top-left)](https://www.star-history.com/#JustEhannn/clickr-ai&type=date&legend=top-left)

## License

[MIT](LICENSE): free for personal and commercial use.

## Acknowledgments

- **[llama.cpp](https://github.com/ggml-org/llama.cpp)**: the engine that runs the local models
- **[Hugging Face](https://huggingface.co)** and **[Unsloth](https://github.com/unslothai/unsloth)**: host the GGUF model files
- **[Qwen](https://github.com/QwenLM)** and **[Gemma](https://ai.google.dev/gemma)**: the open models Clickr offers
- **[Tauri](https://tauri.app/)**: cross-platform desktop framework
- **[React](https://react.dev/)**: UI library
