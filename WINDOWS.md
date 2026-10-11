# Building Clickr for Windows (handoff for Claude Code on a Windows PC)

Read this first, then README.md and RELEASING.md. The Mac app is finished and released (0.1.1);
the Windows port is the next project. The React/TypeScript UI, the Supabase backend, accounts,
billing, tiers and the update feed are shared. Only the native layer differs.

## What Clickr is
Tauri 2 app (React 19 + TypeScript front end in `src/`, Rust in `src-tauri/`). A floating AI "pill" opens on a
global hotkey, can look at the user's screen, chat (Gemini/Claude via Supabase Edge Functions), and on Pro+ run
"Agent Mode" (clicks/types for the user). Backend = Supabase project `xoebvsthsmrnuusduzfg`; website = a separate
repo (`getclickr`, Next.js on Vercel, clickrai.com).

## Set up the PC
1. Install: Git, Node 20+, Rust (rustup, MSVC toolchain), "Visual Studio Build Tools" with the C++ workload, WebView2 (already on Windows 11).
2. `git clone https://github.com/JustEhannn/clickr.git` and `npm install`.
3. `npm run tauri dev` should open the window. Expect compile errors at first (see below): getting `cargo check` green on Windows is task #1.
4. No secrets are needed to run the app. The Supabase URL and anon key are public and already in `src-tauri/src/auth.rs`.

## The native layer to implement: `src-tauri/src/platform/windows.rs`
Today every function is a stub (mac versions live in `platform/macos.rs` and `platform/ax.rs`, use them as the spec).
Suggested crates: `windows` (Win32), `xcap` or Windows.Graphics.Capture for screenshots, `enigo` or `SendInput` for input.

| Function | What it must do on Windows |
|---|---|
| `capture_screen_excluding_windows` | Screenshot (all displays optional) with Clickr's own windows excluded. Windows.Graphics.Capture, or `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on Clickr windows then a normal capture. |
| `active_window_info` | Foreground app name and window title (GetForegroundWindow, GetWindowText, process image name), skipping Clickr itself. |
| `install_click_through_monitor` | Pill should let clicks fall through transparent areas (WS_EX_TRANSPARENT / `set_ignore_cursor_events`). |
| `mouse_click`, `type_text`, `press_key`, `scroll` | Agent input via `SendInput`. The `real` flag means "move the user's real cursor"; Windows has no per-process input, so treat everything as real or use UI Automation patterns. |
| `to_screen_point`, `main_display_bounds` | Coordinate mapping, DPI aware (per-monitor DPI v2). |
| `frontmost_pid`, `pid_at_point` | GetForegroundWindow / WindowFromPoint to PID. |
| `accessibility_trusted`, `request_accessibility` | Not needed on Windows: return true. (Elevated windows ignore input from non-elevated apps; consider telling the user.) |
| `hide_dock_icon`, `disable_window_shadow` | Probably no-ops. |

Also needed: an accessibility-tree listing for Agent Mode (mac uses AX in `ax.rs`; Windows equivalent is UI Automation).

## Mac-only code to gate or replace in `lib.rs` / `agent.rs`
- `tauri-nspanel` (the floating panel that appears over full-screen apps): Windows uses a normal always-on-top, undecorated, skip-taskbar window.
- Screen Recording permission commands (`check_screen_recording_permission`, `request_screen_recording_permission`, the settings deep link in `open_system_settings_pane`): on Windows these should report "granted" and the permission popup in `src/App.tsx` should not show.
- `core-graphics` / `core-foundation` / macOS pasteboard code, the tray/menu bar behaviour (Windows: system tray icon, window near the taskbar), `LSUIElement` equivalents.
- Global hotkey default `Cmd+Shift+Space` becomes `Ctrl+Shift+Space` (the code already maps CmdOrCtrl).
- UI text that says "Mac", "macOS", "System Settings", "Screen Recording" needs Windows wording.

## Packaging, signing, updates
- Build: `npm run tauri build` makes an NSIS installer (`.exe`) or MSI. Add a `windows` section in `src-tauri/tauri.conf.json` (the `bundle.windows` key) and set `bundle.targets`.
- Updates reuse the same updater key. The public key is already in `tauri.conf.json`; the PRIVATE key is `~/.tauri/clickr-updater.key` on the Mac. Copy it to the PC securely (password manager / encrypted drive, never git or chat) to sign Windows updates.
- Extend `scripts/release.sh` (bash; run it in Git Bash/WSL) or add `release-windows.ps1` to upload `Clickr-<ver>-setup.exe` and add a `windows-x86_64` entry to the SAME `latest.json` (it currently only has darwin entries). Never overwrite the mac entries.
- Unsigned installers trigger Microsoft SmartScreen ("Windows protected your PC"), like Gatekeeper on Mac. A code-signing certificate (Azure Trusted Signing or an OV/EV cert) fixes it when going public.
- Website: `/download` page has a disabled Windows card, `app/download/mac/route.ts` is the Mac link. Add `app/download/windows/route.ts` redirecting to the new installer, enable the Windows card and the hero button.

## Order I would build it in
1. `cargo check` / `npm run tauri dev` green with stubs (gate the mac-only code).
2. Window behaviour: hotkey, pill window, tray icon, hide/show, click-through, position.
3. Screenshot capture, then chat works end to end.
4. Active window info, file drops, notifications, autostart.
5. Agent Mode (input + UI Automation tree).
6. Installer, updater, signing, release script, website download.

## Rules that already exist (keep them)
- Never print or commit secrets. Live Stripe and Supabase service keys are not needed for client work.
- Server-side limits live in Supabase; client gating is `src/tiers.ts`.
- Panel colour is `#05060A`, accent `#3C83F5`; no purple, no neon blue.
