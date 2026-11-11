import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MODELS, recommended } from "./models";

type Status = { engine: boolean; models: { name: string; size: number }[]; active: string | null };
type Progress = { label: string; done: number; total: number } | null;

const gb = (n: number) => (n / 1e9).toFixed(1);

/**
 * First-run step (and "Get more models"): pick a free model and Clickr downloads it, plus a small
 * one-time engine to run it. Nothing else to install. Everything runs on this computer.
 */
export default function SetupAI({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [ram, setRam] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const st = await invoke<Status>("ai_status").catch(() => null);
    if (st) setStatus(st);
  }, []);

  useEffect(() => {
    void invoke<number>("system_ram_gb").then(setRam).catch(() => {});
    void refresh();
    const un = listen<{ phase: string; completed: number; total: number }>("ai-pull", (e) => {
      const { phase, completed, total } = e.payload;
      setProgress({ label: phase === "engine" ? "Downloading the AI engine (one time)" : "Downloading the model", done: completed, total });
    });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      void un.then((fn) => fn());
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, onClose, busy]);

  const suggested = recommended(ram);
  const selected = picked ?? suggested.tag;
  const chosen = MODELS.find((m) => m.tag === selected);
  const downloaded = (tag: string) => !!status?.models.some((m) => m.name === tag);

  async function start() {
    if (!chosen) return;
    setError("");
    setBusy(true);
    try {
      if (!downloaded(chosen.tag)) await invoke("ai_download_model", { tag: chosen.tag, repo: chosen.repo });
      await invoke("ai_set_model", { model: chosen.tag });
      onDone();
    } catch (e) {
      setError(String(e));
      void refresh();
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        {/* Drag the whole window by this header. */}
        <div
          className="setup-drag"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("button, a, input")) return;
            void getCurrentWindow().startDragging();
          }}
        >
          <div className="setup-title">Set up your AI</div>
          <p className="setup-lead">
            Clickr runs a free, open-source AI on your own computer. It&apos;s private, works offline and costs nothing. Pick a model: bigger
            is smarter but slower{ram ? `, and your Mac has ${ram} GB of memory` : ""}.
          </p>
        </div>

        <div className="setup-models">
          {MODELS.map((m) => {
            const tight = ram > 0 && m.minRam > ram;
            return (
              <button
                key={m.tag}
                type="button"
                className={`setup-model ${selected === m.tag ? "selected" : ""}`}
                disabled={busy}
                onClick={() => setPicked(m.tag)}
              >
                <div className="setup-model-top">
                  <span className="setup-model-name">{m.name}</span>
                  {m.tag === suggested.tag && <span className="setup-chip accent">Recommended</span>}
                  {downloaded(m.tag) && <span className="setup-chip">Downloaded</span>}
                  <span className="setup-model-size">{m.sizeGB} GB</span>
                </div>
                <div className="setup-model-sub">
                  <span className={`setup-quality q-${m.quality.replace(" ", "-").toLowerCase()}`}>{m.quality}</span>
                  <span>{m.blurb}</span>
                </div>
                <div className="setup-model-tags">
                  {m.vision && <span>Sees your screen</span>}
                  <span>{m.agent ? "Agent Mode" : "No Agent Mode"}</span>
                  <span>Needs {m.minRam} GB memory</span>
                  {tight && <span className="warn">May be slow on this Mac</span>}
                </div>
              </button>
            );
          })}
        </div>

        <div className="setup-footer">
          {progress && (
            <div className="setup-progress">
              <div className="setup-progress-row">
                <span>{progress.label}</span>
                <span>{progress.total > 0 ? `${gb(progress.done)} / ${gb(progress.total)} GB` : "…"}</span>
              </div>
              <div className="setup-bar">
                <div className={`setup-bar-fill ${pct === null ? "indeterminate" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
              </div>
            </div>
          )}
          {error && <div className="setup-error">{error}</div>}

          <button className="setup-primary" type="button" disabled={busy || !chosen} onClick={() => void start()}>
            {busy ? "Working…" : downloaded(selected) ? "Use this model" : `Download and use (${chosen?.sizeGB} GB${status?.engine ? "" : " + 17 MB engine"})`}
          </button>
          <button className="setup-link" type="button" disabled={busy} onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
