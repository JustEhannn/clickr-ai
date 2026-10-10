import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import clickrLogoFull from "./assets/clickr-logo-full.png";
import { reportProblem } from "./bugReport";

type Stage = "idle" | "waiting";

/**
 * Sign-in lives on the Clickr website (password or Google). This window just
 * opens it; when you finish there, the site sends you back here with a one-time
 * link and this window closes itself.
 */
export default function AuthApp() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    const unlisteners = [
      listen<{ signed_in: boolean }>("session-updated", (event) => {
        if (event.payload.signed_in) void appWindow.close();
      }),
      listen<string>("session-error", (event) => {
        setError(event.payload || "Sign-in didn't work. Please try again.");
        setStage("idle");
        void appWindow.show();
        void appWindow.setFocus();
      }),
    ];
    return () => {
      unlisteners.forEach((u) => void u.then((fn) => fn()));
    };
  }, [appWindow]);

  async function openBrowser() {
    setError("");
    try {
      await invoke("start_web_sign_in");
      setStage("waiting");
      // Get out of the way while the browser does the sign-in. It comes back on
      // an error, or from the tray / hotkey if you want to retry.
      await appWindow.hide();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main
      className="clickr-root settings-window-root"
      onMouseDown={(e) => {
        // Drag the window from anywhere that isn't a button.
        if ((e.target as HTMLElement).closest("button, a, input")) return;
        void appWindow.startDragging();
      }}
    >
      <section className="settings-window-panel auth-panel auth-panel-centered">
        <button className="auth-close" type="button" onClick={() => void invoke("quit_app")} aria-label="Quit Clickr">
          ✕
        </button>

        <div className="auth-header">
          <div className="auth-logo-glow">
            <img src={clickrLogoFull} alt="Clickr" className="auth-logo" />
          </div>
          <div className="settings-title">Sign in / Sign up</div>
          <div className="settings-subtitle">
            {stage === "waiting"
              ? "Finish signing in in your browser — Clickr will open automatically."
              : "One account for Free, Pro and Pro+, on every device."}
          </div>
        </div>

        {error && (
          <div className="auth-error">
            {error}{" "}
            <button className="bug-link" type="button" onClick={() => reportProblem("crash", `Sign-in: ${error}`)}>
              Report this problem
            </button>
          </div>
        )}

        <button className="auth-cta" type="button" onClick={() => void openBrowser()}>
          {stage === "waiting" ? "Open the sign-in page again" : "Continue in browser"}
        </button>

        {stage === "waiting" && (
          <div className="auth-waiting">
            <span className="status-spinner" /> Waiting for you to sign in…
          </div>
        )}
      </section>
    </main>
  );
}
