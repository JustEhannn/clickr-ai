import { invoke } from "@tauri-apps/api/core";

export type BugSource = "settings" | "chat-error" | "agent" | "crash";

/**
 * Opens the bug report window. `error` (if any) is what went wrong; it is attached to the
 * report so the user doesn't have to describe it from memory.
 */
export function reportProblem(source: BugSource, error?: unknown) {
  try {
    localStorage.setItem(
      "clickr-bug-prefill",
      JSON.stringify({
        source,
        error: error === undefined ? "" : String(error instanceof Error ? error.message : error).slice(0, 1500),
        at: new Date().toISOString(),
      }),
    );
  } catch {
    // Storage can be unavailable; the report window still opens.
  }
  void invoke("open_bug_report").catch(() => {});
}
