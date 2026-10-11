import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import type { BugSource } from "./bugReport";
import { OS_NAME } from "./platform";

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
  const [email, setEmail] = useState<string | null>(null);
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
    invoke<{ email: string | null }>("get_session").then((s) => setEmail(s.email)).catch(() => {});
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
        const [diag, sub] = await Promise.all([
          invoke<Record<string, unknown>>("bug_diagnostics").catch(() => ({})),
          invoke<{ tier: string }>("get_subscription").catch(() => null),
        ]);
        Object.assign(context, diag);
        if (sub) context.plan = sub.tier;
      }
      await invoke("submit_bug_report", { message: text, context });
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
            <div className="settings-subtitle">Report a bug — we read every one.</div>
          </div>
          <button className="settings-close" type="button" onClick={() => void appWindow.close()} aria-label="Close">
            ✕
          </button>
        </div>

        {stage === "sent" ? (
          <div className="bug-sent" ref={innerRef}>
            <div className="bug-sent-check">✓</div>
            <div className="bug-sent-title">Thanks — we got it</div>
            <div className="bug-sent-text">We&apos;ll look into this and may reach out at {email ?? "your email"}.</div>
          </div>
        ) : (
          <div className="settings-scroll bug-form">
           <div className="bug-form-inner" ref={innerRef}>
            <div className="bug-field">
              <label className="studio-label">Your email</label>
              <div className="bug-email">{email ?? "…"}</div>
            </div>

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
                Include app version, {OS_NAME} version and my plan
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
