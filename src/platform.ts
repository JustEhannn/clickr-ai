// Small platform flags for wording and key labels. The native side is chosen at build time;
// this only decides what the UI says ("Ctrl" vs "⌘", "PC" vs "Mac").
export const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** The "command" modifier as a user sees it on their keyboard. */
export const MOD_KEY = IS_WINDOWS ? "Ctrl" : "⌘";
/** "Enter" glyph for keycaps. */
export const ENTER_KEY = IS_WINDOWS ? "Enter" : "↵";
export const OS_NAME = IS_WINDOWS ? "Windows" : "macOS";
export const DEVICE_NAME = IS_WINDOWS ? "PC" : "Mac";
