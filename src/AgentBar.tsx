import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * The small pill shown while Agent Mode runs (the chat itself is hidden so it
 * never gets in the way). About 75% shows what the agent is doing; the rest
 * holds Stop, or Allow / Skip when an action needs approval.
 */
export default function AgentBar() {
  const [text, setText] = useState("Getting started…");
  const [stopLabel, setStopLabel] = useState("Stop");
  const [approval, setApproval] = useState<string | null>(null);

  useEffect(() => {
    const unlisteners = [
      listen<{ text: string; stopLabel?: string }>("agent-status", (e) => {
        setText(e.payload.text);
        setStopLabel(e.payload.stopLabel ?? "Stop");
      }),
      listen<{ text: string } | null>("agent-approval", (e) => setApproval(e.payload?.text ?? null)),
    ];
    return () => {
      unlisteners.forEach((u) => void u.then((fn) => fn()));
    };
  }, []);

  const decide = (decision: "approve" | "approve_all" | "deny" | "stop") => {
    void emit("agent-decision", { decision });
  };

  return (
    <div className={`agent-bar ${approval ? "asking" : ""}`}>
      <div className="agent-bar-text" title={approval ?? text}>
        {approval ? (
          <>
            <span className="agent-bar-label">Allow?</span>
            <span className="agent-bar-line">{approval}</span>
          </>
        ) : (
          <>
            <span className="status-spinner" />
            <span className="agent-bar-line">{text}</span>
          </>
        )}
      </div>

      <div className="agent-bar-actions">
        {approval && (
          <>
            <button type="button" className="agent-bar-btn primary" onClick={() => decide("approve")}>
              Allow
            </button>
            <button type="button" className="agent-bar-btn" onClick={() => decide("approve_all")}>
              All
            </button>
            <button type="button" className="agent-bar-btn" onClick={() => decide("deny")}>
              Skip
            </button>
          </>
        )}
        <button type="button" className="agent-bar-btn stop" onClick={() => decide("stop")}>
          {stopLabel}
        </button>
      </div>
    </div>
  );
}
