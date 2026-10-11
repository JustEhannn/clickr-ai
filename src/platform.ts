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
