import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MODELS, recommended, type ModelOption } from "./models";

type Status = { installed: boolean; running: boolean; models: { name: string; size: number }[]; active: string | null };
type Progress = { label: string; done: number; total: number } | null;

const gb = (n: number) => (n / 1e9).toFixed(1);

/**
 * First-run step (and "Get more models"): install Ollama, then download a free model and use it.
 * Everything runs on this computer.
 */
export default function SetupAI({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [ram, setRam] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const st = await invoke<Status>("ollama_status").catch(() => null);
    if (st) setStatus(st);
    return st;
  }, []);

  useEffect(() => {
    void invoke<number>("system_ram_gb").then(setRam).catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    const un = [
      listen<{ phase: string; done: number; total: number }>("ollama-install", (e) => {
        const { phase, done, total } = e.payload;
        setProgress({ label: phase === "download" ? "Downloading Ollama" : "Installing Ollama", done, total });
      }),
      listen<{ status: string; completed: number; total: number }>("ollama-pull", (e) => {
        const { status: s, completed, total } = e.payload;
        setProgress({ label: total ? "Downloading model" : s.charAt(0).toUpperCase() + s.slice(1), done: completed, total });
      }),
    ];
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(timer);
      un.forEach((p) => void p.then((fn) => fn()));
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, onClose]);

  const suggested = recommended(ram);
  const selected = picked ?? suggested.tag;
  const ready = !!status?.running;
  const downloaded = (tag: string) => !!status?.models.some((m) => m.name === tag || m.name === `${tag}:latest`);

  async function run(task: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
      void refresh();
    }
  }

  const install = () =>
    run(async () => {
      await invoke("ollama_install");
      setProgress({ label: "Starting Ollama", done: 0, total: 0 });
      await invoke("ollama_start");
    });

  const start = () => run(() => invoke("ollama_start"));

  const useModel = (tag: string) =>
    run(async () => {
      if (!downloaded(tag)) await invoke("ollama_pull", { model: tag });
      await invoke("ollama_set_model", { model: tag });
      onDone();
    });

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div className="agent-beta-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="agent-beta-card setup-card">
        <button className="agent-beta-close" type="button" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {/* Drag the whole window by this header, like the chat's own drag handle. */}
        <div
          className="setup-drag"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("button, a, input")) return;
            void getCurrentWindow().startDragging();
          }}
        >
          <div className="agent-beta-title">Set up your AI</div>
          <p className="agent-beta-text">
            Clickr runs a free open-source AI on your own computer. It&apos;s private, works offline, and costs nothing.
          </p>
        </div>

        <div className="setup-step">
          <span className={`setup-dot ${ready ? "done" : ""}`}>{ready ? "✓" : "1"}</span>
          <div className="setup-step-body">
            <div className="setup-step-title">Install Ollama</div>
            <div className="setup-step-sub">The free app that runs the AI. About 150 MB.</div>
          </div>
          {!ready &&
            (status?.installed ? (
              <button className="setup-btn" type="button" disabled={busy} onClick={start}>
                Start
              </button>
            ) : (
              <button className="setup-btn" type="button" disabled={busy} onClick={install}>
                Install
              </button>
            ))}
        </div>
        {!ready && !status?.installed && (
          <button className="setup-link" type="button" onClick={() => void openUrl("https://ollama.com/download")}>
            Or download it yourself from ollama.com
          </button>
        )}

        <div className={`setup-step ${ready ? "" : "off"}`}>
          <span className="setup-dot">2</span>
          <div className="setup-step-body">
            <div className="setup-step-title">Choose a model</div>
            <div className="setup-step-sub">
              Bigger is smarter but slower.{ram ? ` Your Mac has ${ram} GB of memory.` : ""}
            </div>
          </div>
        </div>

        <div className={`setup-models ${ready ? "" : "off"}`}>
          {MODELS.map((m: ModelOption) => {
            const tight = ram > 0 && m.minRam > ram;
            return (
              <button
                key={m.tag}
                type="button"
                className={`setup-model ${selected === m.tag ? "selected" : ""}`}
                disabled={!ready || busy}
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
                  {tight && <span className="warn">Needs {m.minRam} GB, may be slow</span>}
                </div>
              </button>
            );
          })}
        </div>

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

        <button className="agent-beta-confirm" type="button" disabled={!ready || busy} onClick={() => void useModel(selected)}>
          {busy ? "Working…" : downloaded(selected) ? "Use this model" : `Download and use (${MODELS.find((m) => m.tag === selected)?.sizeGB} GB)`}
        </button>
        <button className="setup-link" type="button" onClick={onClose}>
          Not now
        </button>
      </div>
    </div>
  );
}
