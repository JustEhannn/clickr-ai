# Windows port

Clickr AI is macOS-only today. This file is the starting point for a Windows port. The React UI, the Ollama integration and Agent Mode's planning are shared; the native layer is not.

> **Rules:** work on a branch; put every Windows change behind `#[cfg(windows)]` (Rust) or a runtime platform check (TypeScript); do not edit `platform/macos.rs`, `platform/ax.rs` or the `#[cfg(target_os = "macos")]` blocks except to add a sibling Windows block; before merging, `cargo check` and `npm run build` must still pass on macOS.

## What Clickr is
A Tauri 2 app (React 19 + TypeScript in `src/`, Rust in `src-tauri/`). A floating window opens on a global hotkey, can look at the screen, and talks to a local model through Ollama (`src-tauri/src/ollama.rs`). Agent Mode (`agent.rs`) asks the model for one tool call at a time and runs it through `platform/`. No server, no account.

## Set up the PC
Install Git, Node 20+, Rust (MSVC toolchain) and Visual Studio Build Tools (C++ workload). Then `git clone`, `npm install`, `npm run tauri dev`. Install [Ollama for Windows](https://ollama.com/download) to test chat. Expect compile errors at first: getting `cargo check` green is task one.

## `src-tauri/src/platform/windows.rs` is all stubs
The macOS versions (`platform/macos.rs`, `platform/ax.rs`) are the spec. Suggested: the `windows` crate (Win32), Windows.Graphics.Capture or DXGI for screenshots, `SendInput` for input, UI Automation for the accessibility tree.

| Function | What it must do on Windows |
|---|---|
| `capture_screen_excluding_windows` | Screenshot (optionally all displays) without Clickr's own windows: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on Clickr windows, then capture. Return `(width, height, rgba)` unchanged. |
| `active_window_info` | Foreground app name and window title, skipping Clickr. |
| `install_click_through_monitor` | Let clicks fall through the transparent parts of the window. |
| `mouse_click`, `type_text`, `press_key`, `scroll` | Agent input via `SendInput`. Windows has no per-process input, so treat `real` as always true. |
| `to_screen_point`, `main_display_bounds` | DPI-aware (per-monitor v2) coordinate mapping. |
| `frontmost_pid`, `pid_at_point` | `GetForegroundWindow` / `WindowFromPoint`. |
| `accessibility_trusted`, `request_accessibility` | Return true. |
| `hide_dock_icon`, `disable_window_shadow` | Probably no-ops. |

Agent Mode also lists on-screen controls (macOS: AX tree in `ax.rs`; Windows: UI Automation).

## Also needed
- **`ollama.rs`:** `ollama_install` only handles macOS (downloads and unpacks the zip). On Windows, download `OllamaSetup.exe` and run it, or open ollama.com. `system_ram_gb` returns 0; use `GlobalMemoryStatusEx`.
- **`lib.rs`:** `restart_app` shells out to `/bin/sh` and `open` (macOS). The `main` window uses `tauri-nspanel` on macOS; Windows needs a normal always-on-top, undecorated, skip-taskbar window. Windows are created in Rust (`app.windows` is `[]`); every window label must be in `src-tauri/capabilities/default.json`.
- **Screen Recording / Accessibility prompts** must never show on Windows (the permission commands should report granted).
- **Wording:** "macOS", "System Settings", "Screen Recording" and the `⌘` hotkey display need Windows text.
- **Packaging:** NSIS installer (`bundle.windows`), an updater entry for `windows-x86_64` in `latest.json`, and a code-signing certificate to avoid SmartScreen warnings.

## Definition of done
Installer builds; hotkey works from any app; first-run setup installs Ollama and downloads a model; chat streams; the screenshot excludes Clickr's windows (multi-monitor, 100-200% scaling); Agent Mode clicks and types in Notepad, a browser and File Explorer with Stop working; macOS still builds.

Colors: panels `#05060A`, accent `#3C83F5`.
