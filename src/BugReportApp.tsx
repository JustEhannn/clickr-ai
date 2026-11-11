import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BugSource } from "./bugReport";

type Prefill = { source: BugSource; error: string; at: string } | null;
type Stage = "form" | "sending" | "sent";

function readPrefill(): Prefill {
  try {
    const raw = localStorage.getItem("clickr-bug-prefill");
    if (!raw) return null;
    localStorage.removeItem("clickr-bug-prefill");
    return JSON.parse(raw) as Prefill;
  } catch {
    return null;
  }
}

const HEADINGS: Record<BugSource, string> = {
  settings: "Tell us what's wrong",
  "chat-error": "Sorry about that",
  agent: "Sorry about that",
  crash: "Something broke",
};

/** The window people use to report a bug. It never closes on its own when you click away. */
export default function BugReportApp() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [prefill, setPrefill] = useState<Prefill>(() => readPrefill());
  const [message, setMessage] = useState("");
  const [includeInfo, setIncludeInfo] = useState(true);
  const [stage, setStage] = useState<Stage>("form");
  const [error, setError] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // Size the window to exactly fit what is showing, so nothing scrolls and there is no dead space.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => {
      const header = headerRef.current;
      const inner = innerRef.current;
      if (!header || !inner) return;
      // header + content + the scroll area's padding (27) + the window's outer padding (24) + borders
      const total = Math.ceil(header.offsetHeight + inner.offsetHeight + 27 + 24 + 2);
      void appWindow.setSize(new LogicalSize(380, Math.min(Math.max(total, 260), 720))).catch(() => {});
    });
    return () => cancelAnimationFrame(id);
  }, [appWindow, stage, prefill, error]);

  useEffect(() => {
    textRef.current?.focus();
    // Opened again while already showing (e.g. a second error): pick up the new details.
    const un = listen("bug-prefill", () => {
      const p = readPrefill();
      if (p) setPrefill(p);
      setStage("form");
      setError("");
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  async function submit() {
    const typed = message.trim();
    const text = typed || (prefill?.error ? `Automatic report: ${prefill.error}` : "");
    if (text.length < 3) {
      setError("Please describe what went wrong — a sentence or two is plenty.");
      return;
    }
    setError("");
    setStage("sending");
    try {
      const context: Record<string, unknown> = { source: prefill?.source ?? "settings" };
      if (prefill?.error) context.error = prefill.error;
      if (includeInfo) {
        Object.assign(context, await invoke<Record<string, unknown>>("bug_diagnostics").catch(() => ({})));
      }
      // Reports are public GitHub issues: open a pre-filled one in the browser.
      const details = Object.entries(context).map(([k, v]) => `- ${k}: ${String(v)}`).join("\n");
      const body = `${text}\n\n---\n${details}`.slice(0, 5000);
      await openUrl(
        `https://github.com/JustEhannn/clickr-ai/issues/new?title=${encodeURIComponent(text.slice(0, 70))}&body=${encodeURIComponent(body)}`,
      );
      setStage("sent");
      window.setTimeout(() => void appWindow.close(), 2200);
    } catch (e) {
      setError(String(e));
      setStage("form");
    }
  }

  return (
    <main className="clickr-root settings-window-root">
      <section className="settings-window-panel settings-window-panel-v2">
        <div
          ref={headerRef}
          className="settings-header settings-drag-handle"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("button, input, textarea")) return;
            void appWindow.startDragging();
          }}
        >
          <div>
            <div className="settings-title">{HEADINGS[prefill?.source ?? "settings"]}</div>
            <div className="settings-subtitle">Opens a pre-filled issue on GitHub.</div>
          </div>
          <button className="settings-close" type="button" onClick={() => void appWindow.close()} aria-label="Close">
            ✕
          </button>
        </div>

        {stage === "sent" ? (
          <div className="bug-sent" ref={innerRef}>
            <div className="bug-sent-check">✓</div>
            <div className="bug-sent-title">Almost done</div>
            <div className="bug-sent-text">Press “Submit new issue” on GitHub to send it. Nothing is shared until you do.</div>
          </div>
        ) : (
          <div className="settings-scroll bug-form">
           <div className="bug-form-inner" ref={innerRef}>

            {prefill?.error && (
              <div className="bug-captured">
                <div className="studio-label">What went wrong (attached automatically)</div>
                <div className="bug-captured-text">{prefill.error}</div>
              </div>
            )}

            <div className="bug-field">
              <label className="studio-label">
                {prefill?.error ? "What were you doing? (optional)" : "What happened?"}
              </label>
              <textarea
                ref={textRef}
                className="model-input bug-textarea"
                placeholder={
                  prefill?.error
                    ? "e.g. I asked about my screen and it stopped answering"
                    : "Describe the problem and what you expected to happen"
                }
                value={message}
                maxLength={4000}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            <label className="bug-check">
              <input type="checkbox" checked={includeInfo} onChange={(e) => setIncludeInfo(e.target.checked)} />
              <span>
                Include app version, macOS version and my plan
                <small>No screenshots or chat contents are sent.</small>
              </span>
            </label>

            {error && <div className="auth-error">{error}</div>}

            <button className="auth-cta" type="button" disabled={stage === "sending"} onClick={() => void submit()}>
              {stage === "sending" ? "Sending…" : "Send report"}
            </button>
           </div>
          </div>
        )}
      </section>
    </main>
  );
}
