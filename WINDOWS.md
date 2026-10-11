# Building Clickr for Windows (handoff for Claude Code on a Windows PC)

> **Golden rules (read before touching anything)**
> 1. The Mac app is LIVE with real paying customers (0.1.1). Do all work on a branch (`git checkout -b windows`), never commit straight to `main`, and never run the Mac release scripts.
> 2. Every change must be Windows-only: put it behind `#[cfg(windows)]` / `#[cfg(target_os = "windows")]` (Rust) or a runtime platform check (TypeScript). Do NOT edit `platform/macos.rs`, `platform/ax.rs`, or the `#[cfg(target_os = "macos")]` blocks except to add a sibling Windows block. If you must change shared code, keep the Mac behaviour byte-for-byte identical and say so in the commit message.
> 3. Do not change anything server-side (Supabase functions, migrations, tier limits, Stripe). Those are shared with the live Mac app. Ask the owner first.
> 4. Never print, commit, or paste secrets. You do not need any to build.
> 5. Before merging to `main`, the owner (or a Mac) must run `cargo check` + `npm run build` on macOS to prove the Mac build still compiles and runs.

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

## Facts about the existing code you will otherwise rediscover the hard way

**Windows are created in Rust, not in tauri.conf.** `app.windows` is `[]`. `lib.rs` builds these labels: `main` (the pill/chat), `settings`, `auth` (sign-in), `cursor` (Agent Mode's own cursor overlay), `agentbar` (Agent Mode status bar), `bugreport`. All six are listed in `src-tauri/capabilities/default.json`; any new window label must be added there or its IPC calls are silently denied. The front end picks its screen from the window label/route in `src/main.tsx`.

**Already cross-platform / already gated.** `lib.rs` and `agent.rs` have ~30 `#[cfg(target_os = "macos")]` blocks, most with a `#[cfg(not(target_os = "macos"))]` fallback. Start by reading those fallbacks: they are the places Windows needs real code. Cargo already scopes `tauri-nspanel`, `screencapturekit`, `objc2*`, `core-graphics` to macOS only; the `autostart`, `updater`, `notification` and `single-instance` plugins already target Windows too; `keyring` already enables `windows-native` (Windows Credential Manager holds the session).

**Mac-only flags.** `tauri.conf.json` has `"macOSPrivateApi": true` and the `tauri` crate has the `macos-private-api` feature. Transparent windows on Windows work without these, but keep them for Mac. Windows transparent windows need `transparent: true` and `decorations: false`, and WebView2 must be allowed to draw a transparent background.

**Sign-in uses a custom URL scheme `clickr://`** (web sign-in hands a one-time code back to the app). In `tauri.conf.json` it is `plugins.deep-link.desktop.schemes = ["clickr"]`. The installer registers the scheme on Windows, but under `npm run tauri dev` it is NOT registered until you call `app.deep_link().register("clickr")` (the code only does that on Linux, `lib.rs` ~line 1364): add a Windows dev-mode call. `tauri-plugin-single-instance` with the `deep-link` feature forwards the URL to the running instance; it must stay the first plugin registered.

**Sign-in flow to test:** pill → "Continue in browser" (`start_web_sign_in`) → clickrai.com/app-login → browser redirects to `clickr://…` → app calls `exchange_handoff`. If the deep link doesn't reach the app, sign-in appears to hang.

**Hotkeys.** Default toggle `CmdOrCtrl+Shift+Space`, assist `CmdOrCtrl+Enter`. The UI in `src/SettingsApp.tsx` (~line 113) and `src/App.tsx` (~2737) renders the modifier as `⌘`; make that display `Ctrl` on Windows (derive from a platform flag, don't hard-code). Check `Ctrl+Shift+Space` isn't swallowed by Windows IME language switching.

**Front end Mac wording to localise for Windows:** "macOS", "System Settings", "Screen Recording", "Accessibility", "Open at login" explanations, the bug report checkbox ("macOS version"), the permissions popup in `App.tsx` (`screenRecordingGranted === false` overlay) and the Agent Mode Accessibility step (`turnAgentOn`/`request_accessibility`). On Windows `check_screen_recording_permission` and `request_accessibility` must return true so those prompts never appear.

**Screen capture must exclude Clickr's own windows** (so the AI doesn't see its own pill). Mac does it with ScreenCaptureKit window exclusion; on Windows use `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` on each Clickr window, then capture normally (Windows.Graphics.Capture or DXGI). The return type is `(width, height, rgba bytes)`; keep it identical so `lib.rs` encodes and sends it unchanged. Multi-monitor and per-monitor DPI scaling are required: coordinates the AI returns are in screenshot pixels and `to_screen_point` converts them to real screen points.

**Agent Mode** (`agent.rs`) asks the AI for one action at a time (click/type/key/scroll/etc.), executes it through the `platform` functions, re-screenshots, repeats. It has guards you must preserve: it never types into the wrong app (checks the frontmost app), a typed-since-submit guard, a repeated-action/failure-streak stop, an Esc/Stop button, and it hides Clickr's UI while running (cursor overlay + status bar windows). The macOS "pid-posted" input path (works without moving the user's real mouse) has no Windows equivalent: set `real = true` semantics. Elevated (admin) windows ignore input from a non-elevated app: detect and tell the user instead of failing silently.

**Where files live.** Per-user settings/history are stored by the front end in `localStorage` (see `src/storage.ts`, keys include the user id). Do not move them.

## Coordination between the two platforms
- **One version number for both.** `scripts/bump-version.sh X.Y.Z` edits `package.json`, `Cargo.toml` and `tauri.conf.json`. A release of one platform must not change the other's behaviour; merging Windows work only adds files/cfg blocks.
- **One update feed.** `https://xoebvsthsmrnuusduzfg.supabase.co/storage/v1/object/public/releases/latest.json` currently has `darwin-aarch64` and `darwin-x86_64` only. Add `windows-x86_64` (and later `windows-aarch64`) to the SAME file. The Windows release script must READ the current `latest.json`, add/replace only the Windows entry, and write it back. Overwriting it would stop Mac updates. Storage cannot overwrite, so `storage rm --yes` then `storage cp` (see the `up()` helper in `scripts/release.sh`); do it files-first, `latest.json` last.
- **Updater artifact on Windows** is the NSIS `.exe` (plus `.sig`) when `bundle.createUpdaterArtifacts` is true; the signature uses the same minisign key (`TAURI_SIGNING_PRIVATE_KEY`, content of the key file, not a path).
- **Installer choice.** Prefer NSIS (per-user, no admin prompt, supports updater and the `clickr://` scheme registration). Set `bundle.windows.nsis.installMode = "currentUser"`.
- **Website** (`/Users/…/getclickr`, separate repo, owner handles): add `app/download/windows/route.ts` (302 to `…/releases/Clickr-latest-setup.exe`), enable the Windows card in `app/download/page.tsx` and the Windows option in `components/Hero.tsx`, update the FAQ and `lib/status.ts`.
- **Backend needs nothing.** Plans, limits and the AI proxy are platform-agnostic. Device limit (Free = 1 device) uses a random per-install id, which already works on Windows.

## Definition of done (test checklist, run on a clean Windows 10/11 machine)
1. Install via the installer; SmartScreen warning is expected until a code-signing certificate is added.
2. First launch shows the sign-in; "Continue in browser" signs in via Google and via email, and returns to the app (deep link).
3. Global hotkey shows/hides the pill from any app, including full-screen apps; pill is draggable, remembers position, never shows in the taskbar/Alt-Tab unless intended; tray icon menu works (Settings, Report a bug, Quit).
4. Ask a text question; ask a screen question (screenshot excludes Clickr, multi-monitor, 100%/150%/200% scaling); attach/drop/paste an image and a PDF; streaming answer renders; Stop works.
5. Free vs Pro vs Pro+ gating (use the 100%-off promo code in Stripe live mode or a test account) and the upgrade modal opens the browser.
6. Settings: hotkeys, custom models (Pro+), memory, open at login (autostart), software update check, report a bug.
7. Agent Mode (Pro+): click, type, scroll, key combos in Notepad, a browser, File Explorer; the stop button; no typing into the wrong window; admin-window case handled.
8. Auto-update: install version N, publish N+1, confirm the app offers and installs it, and the Mac entry in `latest.json` is untouched.
9. Uninstall leaves no background process; sign out clears the Credential Manager entry.
10. On macOS: `cargo check`, `npm run build`, and the app still launches and runs a chat (proves the Mac side is not broken).

## Known pitfalls
- `crate-type = ["staticlib","cdylib","rlib"]` + lib name `clickr_lib` is intentional (Windows linker name clash workaround). Don't rename.
- Release profile uses `lto = true`, `panic = "abort"`, `strip = true`: a panic in any thread kills the app. Prefer `Result` over `unwrap()` in new Windows code.
- Windows has no `/bin/sh`: `restart_app` in `lib.rs` shells out to `/bin/sh` and `/usr/bin/open` (macOS). Give it a Windows branch (spawn the current exe after a short delay, then exit) or use `tauri::AppHandle::restart()`.
- Paths: don't assume `/` or `~`; use Tauri's path APIs.
- Font/emoji rendering and the `-webkit-` CSS used by the pill may look different in WebView2: verify the dark `#05060A` panels, blur, and drag regions.
- The CSP in `tauri.conf.json` was validated on macOS. Windows serves the app from `http://tauri.localhost`, so `http://ipc.localhost` and `asset:` entries are already included; test image attach and drag-drop specifically.
