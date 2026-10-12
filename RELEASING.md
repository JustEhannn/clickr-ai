# Releasing a Clickr update

## The three things to know

**1. The link for your website's Download buttons** is always:

```
https://www.clickrai.com/download/mac
```

That address forwards to the newest build, so it never changes and you never edit it. (The website
repo has this wired up already: `app/download/mac/route.ts`.)

**2. To send an update to everyone**, run two commands from this project folder:

```bash
scripts/bump-version.sh 0.1.1
scripts/release.sh "What's new, in plain English"
```

Pick a version number **higher** than the last one. The script builds the app, signs it, and uploads
it. From then on:
- Anyone who downloads from your site gets the new version.
- Anyone already running Clickr sees "Clickr 0.1.1 is ready — Update now" within a few hours
  (the app checks shortly after launch and every 6 hours; Settings → Software update → Check now
  does it instantly). One click installs it and restarts.

**3. To pull a bad update**, run (with the last version that worked):

```bash
scripts/rollback.sh 0.1.0
```

See "When a release is bad" below.

## One build for every Mac
`release.sh` makes a *universal* build, so one download runs natively on Apple Silicon and Intel.
It needs both Rust targets, which the script adds if missing (`aarch64-apple-darwin`,
`x86_64-apple-darwin`). The first universal build takes longer (it compiles twice).

## What lives where

| Thing | Location |
|---|---|
| Website download link | `https://www.clickrai.com/download/mac` |
| Where that forwards | `https://xoebvsthsmrnuusduzfg.supabase.co/storage/v1/object/public/releases/Clickr-latest.dmg` |
| Update feed (what the app checks) | `.../releases/latest.json` |
| Update bundle (what gets installed) | `.../releases/Clickr-<version>.app.tar.gz` |
| Saved copy of every release's feed entry | `.../releases/manifest-<version>.json` |
| Private signing key | `~/.tauri/clickr-updater.key` — **back this up, never commit it** |
| Public key | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |

## Before you publish (recommended habit)
Build without uploading, install it on your own Mac, and make sure it launches and works:

```bash
DRY_RUN=1 scripts/release.sh "test"
```

It prints where the finished `.dmg` is. Only run the real `scripts/release.sh` once that works.
Catching a broken build here is far better than rolling back.

## When a release is bad
Say you published 0.1.2 and it crashes. There are two groups of people:

1. **People who haven't updated yet** — stop the spread first:

   ```bash
   scripts/rollback.sh 0.1.1
   ```

   This points the update feed and the website download back at 0.1.1 within about a minute.
   Nobody new receives 0.1.2.

2. **People who already installed 0.1.2** — apps only ever move to a *higher* version number, so
   they can't be sent "back" to 0.1.1. Fix the bug and publish it as **0.1.3**
   (`bump-version.sh 0.1.3`, then `release.sh`). They get it automatically, **provided the app
   still launches long enough to check** (it checks 30 seconds after opening). If 0.1.2 crashes the
   instant it opens, those people must download 0.1.3 from the website once by hand — which is why
   the test-before-publishing step above matters.

## How the security works
Every update is signed with the private key. The app only installs an update whose signature
matches the public key baked into it, so nobody who gets hold of the download location can push
malware to your users. **If you lose the private key you can never update the apps already
installed** — they would have to download a new DMG once. Keep a copy in a password manager.

## Other things to know
- Until the app is signed with an Apple Developer ID, each update is ad-hoc signed, so macOS may
  re-ask for Keychain access after updating. A Developer ID certificate removes that.
- "Check now" in Settings says "Couldn't check" until the first release is published.

---

# Windows releases

Windows has its **own update feed**, so a Mac release can never remove or overwrite a Windows update
(and the other way round). Neither script reads or writes the other platform's files.

| Thing | Mac | Windows |
|---|---|---|
| Release script | `scripts/release.sh` | `scripts/release-windows.ps1` (run on a Windows PC) |
| Rollback script | `scripts/rollback.sh <ver>` | `scripts/rollback-windows.ps1 <ver>` |
| Update feed | `releases/latest.json` | `releases/latest-windows.json` |
| Saved feed per version | `manifest-<ver>.json` | `manifest-windows-<ver>.json` |
| Installer download | `Clickr-latest.dmg` | `Clickr-latest-setup.exe` |
| Website link | `/download/mac` | `/download/windows` |

The version number can differ between platforms. To ship a fix to both, commit and merge it once, then
release each platform from its own machine (Mac: `scripts/release.sh`, PC: `scripts/release-windows.ps1`).
Both use the same update-signing key.

## On the Windows PC (one-time)
1. Install Git, Node 20+, Rust (MSVC toolchain), Visual Studio Build Tools with the C++ workload **and the
   Windows 11 SDK**, and run `npm install`.
2. Copy the update-signing key to `%USERPROFILE%\.tauri\clickr-updater.key` (never into git or chat).
3. `npx supabase login`.

## Publishing
```powershell
scripts/bump-version.sh 0.1.2        # in Git Bash
powershell -File scripts/release-windows.ps1 "What's new, in plain English"
```
Test first with `$env:DRY_RUN=1` (builds and signs, uploads nothing).

## Removing the SmartScreen warning
Unsigned installers show "Windows protected your PC". Buy or enable a code-signing certificate
(Azure Trusted Signing, or an OV/EV certificate), then set one of these before running the script:
- `CLICKR_CERT_THUMBPRINT` = the SHA-1 thumbprint of a certificate installed in the Windows store, or
- `CLICKR_SIGN_COMMAND` = a signing command with `%1` for the file (cloud signing services).

## Testing an installer on a PC
The installer is per-user (no admin prompt): run `Clickr AI_<ver>_x64-setup.exe`. It installs to
`%LOCALAPPDATA%\Clickr AI`, adds a Start-menu entry and registers `clickr://`. Uninstalling stops the app and
removes its "open at login" entry and the `clickr://` registration.
