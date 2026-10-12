// Small platform flags for wording and key labels. The native side is chosen at build time;
// this only decides what the UI says ("Ctrl" vs "⌘", "PC" vs "Mac").
export const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** The "command" modifier as a user sees it on their keyboard. */
export const MOD_KEY = IS_WINDOWS ? "Ctrl" : "⌘";
/** "Enter" glyph for keycaps. */
export const ENTER_KEY = IS_WINDOWS ? "Enter" : "↵";
export const OS_NAME = IS_WINDOWS ? "Windows" : "macOS";
export const DEVICE_NAME = IS_WINDOWS ? "PC" : "Mac";

// WebView2 can't blur the desktop behind a transparent window the way macOS does, so on Windows
// the translucent panels get solid backgrounds (see "Windows" at the end of main.css).
if (IS_WINDOWS && typeof document !== "undefined") {
  document.documentElement.classList.add("is-windows");
}

// Windows has no Inter / SF Pro, so the UI would fall back to Arial at 9-12px (designed for
// Retina Macs). Bundle Inter for Windows only; macOS never downloads it.
if (IS_WINDOWS) {
  void import("@fontsource-variable/inter/index.css");
}

// ---- Windows polish: the app should never feel like "a web page in a window" ----
if (IS_WINDOWS && typeof document !== "undefined") {
  // WebView2 keeps browser behaviours that WKWebView on macOS doesn't expose. Switch them off.
  const isEditable = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName));

  // No "Back / Refresh / Save as / Inspect" browser menu; text fields keep Cut / Copy / Paste.
  document.addEventListener("contextmenu", (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });

  // F5 / Ctrl+R reloading the pill would lose the conversation; Ctrl+P prints, Ctrl+F opens a
  // find bar, Ctrl+U / Ctrl+S / F7 are browser features, and Ctrl +/-/0 would zoom the layout.
  document.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const blocked =
        k === "f5" || k === "f7" || k === "f12" ||
        (ctrl && ["r", "p", "u", "s", "f", "g", "j", "o", "+", "-", "=", "0"].includes(k));
      if (blocked) e.preventDefault();
    },
    true,
  );
  // Ctrl + wheel and pinch would zoom the page.
  document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  // Red spell-check squiggles in the chat box look unfinished.
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) t.spellcheck = false;
  });

  // Smooth entrance when the pill is brought up with the hotkey / tray icon.
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen("panel-shown", () => {
      const root = document.documentElement;
      root.classList.remove("panel-enter");
      void root.offsetWidth; // restart the animation if it is already running
      root.classList.add("panel-enter");
      window.setTimeout(() => root.classList.remove("panel-enter"), 260);
    }),
  );
}
