import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { onboardingKey } from "./storage";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { reportProblem } from "./bugReport";

const DEFAULT_TOGGLE_SHORTCUT = "CmdOrCtrl+Shift+Space";
const DEFAULT_ASSIST_SHORTCUT = "CmdOrCtrl+Enter";

type RecordingShortcut = "toggle" | "assist" | null;

function Icon({
  name,
  size = 16,
}: {
  name: "x" | "chevron" | "sparkles" | "user" | "card" | "keyboard" | "sliders" | "brain" | "bug";
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (name === "x") {
    return (
      <svg {...common}>
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    );
  }

  if (name === "sparkles" || name === "brain") {
    return (
      <svg {...common}>
        <path d="M9.5 2a2.5 2.5 0 0 0-2.5 2.5v.6A3.5 3.5 0 0 0 4 8.5v1A3.5 3.5 0 0 0 3 12a3.5 3.5 0 0 0 1 2.5v1A3.5 3.5 0 0 0 7 19h.1a2.5 2.5 0 0 0 4.9-.7V4.5A2.5 2.5 0 0 0 9.5 2z" />
        <path d="M14.5 2a2.5 2.5 0 0 1 2.5 2.5v.6A3.5 3.5 0 0 1 20 8.5v1a3.5 3.5 0 0 1 1 2.5 3.5 3.5 0 0 1-1 2.5v1a3.5 3.5 0 0 1-3 3.46 2.5 2.5 0 0 1-4.9-.66V4.5A2.5 2.5 0 0 1 14.5 2z" />
      </svg>
    );
  }

  if (name === "bug") {
    return (
      <svg {...common}>
        <path d="M8 2l1.9 1.9M16 2l-1.9 1.9" />
        <path d="M9 7.1V6a3 3 0 0 1 6 0v1.1" />
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z" />
        <path d="M12 20v-9M6.5 13H3M17.5 13H21M6.5 18l-2.5 2M17.5 18l2.5 2M6.5 8 4 6M17.5 8 20 6" />
      </svg>
    );
  }

  if (name === "user") {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
      </svg>
    );
  }

  if (name === "card") {
    return (
      <svg {...common}>
        <rect x="2" y="5" width="20" height="14" rx="2.5" />
        <path d="M2 10h20" />
      </svg>
    );
  }

  if (name === "keyboard") {
    return (
      <svg {...common}>
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" />
      </svg>
    );
  }

  if (name === "sliders") {
    return (
      <svg {...common}>
        <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h13M21 18h0" />
        <circle cx="16" cy="6" r="2" />
        <circle cx="8" cy="12" r="2" />
        <circle cx="17" cy="18" r="2" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function shortcutDisplay(shortcut: string) {
  return shortcut
    .replace("CmdOrCtrl", "⌘")
    .replace("Command", "⌘")
    .replace("Control", "⌃")
    .replace("Ctrl", "⌃")
    .replace("Shift", "⇧")
    .replace("Alt", "⌥")
    .replace("Option", "⌥")
    .replace("Enter", "↵")
    .replace("Return", "↵")
    .replace("Key", "")
    .replace("Space", "Space")
    .replace("Digit", "")
    .replace(/\+/g, " ");
}

function keyboardEventToShortcut(e: KeyboardEvent) {
  if (
    e.key === "Meta" ||
    e.key === "Control" ||
    e.key === "Shift" ||
    e.key === "Alt"
  ) {
    return null;
  }

  const modifierParts: string[] = [];

  if (e.metaKey || e.ctrlKey) modifierParts.push("CmdOrCtrl");
  if (e.shiftKey) modifierParts.push("Shift");
  if (e.altKey) modifierParts.push("Alt");

  let key = e.code;

  if (key === "Enter" || key === "NumpadEnter") {
    key = "Enter";
  } else if (key === "Space") {
    key = "Space";
  } else if (key.startsWith("Digit")) {
    key = key.replace("Digit", "");
  } else if (key.startsWith("Key")) {
    key = key.replace("Key", "");
  }

  if (modifierParts.length === 0) return null;

  return [...modifierParts, key].join("+");
}


function SectionHeader({ icon, title }: { icon: "user" | "card" | "sliders" | "brain" | "keyboard" | "bug"; title: string }) {
  return (
    <div className="settings-section-header">
      <span className="settings-section-icon">
        <Icon name={icon} size={13} />
      </span>
      <span className="settings-section-title">{title}</span>
    </div>
  );
}

export default function SettingsApp() {
  const [forceScreenshot] = useState(
    () => localStorage.getItem("clickr-force-screenshot") === "true",
  );

  const [shortcut, setShortcut] = useState(
    () => localStorage.getItem("clickr-global-shortcut") || DEFAULT_TOGGLE_SHORTCUT,
  );

  const [assistShortcut, setAssistShortcut] = useState(
    () => localStorage.getItem("clickr-assist-shortcut") || DEFAULT_ASSIST_SHORTCUT,
  );

  const [recordingShortcut, setRecordingShortcut] = useState<RecordingShortcut>(null);
  const [shortcutError, setShortcutError] = useState("");

  // Must be stable: getCurrentWindow() returns a new object every call, and
  // appWindow is a dependency of the effects below. Un-memoized, every render
  // re-ran those effects, which set state, which re-rendered — an endless
  // loop that made the whole window flicker.
  const appWindow = useMemo(() => getCurrentWindow(), []);

  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "uptodate" | "available" | "installing" | "error">("idle");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  async function checkUpdates() {
    setUpdateState("checking");
    try {
      const update = await checkForUpdate();
      if (update) {
        setPendingUpdate(update);
        setUpdateState("available");
      } else {
        setUpdateState("uptodate");
      }
    } catch {
      // No update feed published yet, or no connection.
      setUpdateState("error");
    }
  }

  async function installUpdate() {
    if (!pendingUpdate) return;
    setUpdateState("installing");
    try {
      await pendingUpdate.downloadAndInstall();
      await invoke("restart_app");
    } catch {
      setUpdateState("error");
    }
  }

  useEffect(() => {
    autostartEnabled().then(setOpenAtLogin).catch(() => {});
  }, []);

  async function toggleOpenAtLogin() {
    const next = !openAtLogin;
    setOpenAtLogin(next); // optimistic; reverted if macOS refuses
    try {
      if (next) await enableAutostart();
      else await disableAutostart();
    } catch {
      setOpenAtLogin(!next);
    }
  }
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const [memories, setMemories] = useState<{ id: string; content: string }[]>([]);
  const [memoryText, setMemoryText] = useState("");
  const [memoryError, setMemoryError] = useState("");

  const [bgInput, setBgInput] = useState(() => localStorage.getItem("clickr-agent-background-input") === "true");
  const [autoApprove, setAutoApprove] = useState(() => localStorage.getItem("clickr-auto-approve") === "true");

  const [ollama, setOllama] = useState<{ models: { name: string; size: number }[]; active: string | null }>({ models: [], active: null });
  const session = { user_id: "local" };

  function refreshOllama() {
    invoke<{ models: { name: string; size: number }[]; active: string | null }>("ollama_status")
      .then(setOllama)
      .catch(() => {});
  }

  useEffect(() => {
    refreshOllama();
    let cleanup: (() => void) | undefined;
    appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) refreshOllama();
    }).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, [appWindow]);

  /** The model picker lives in the chat window: ask it to open the setup screen, then step aside. */
  async function openAiSetup() {
    await emit("open-ai-setup");
    await appWindow.close();
  }

  useEffect(() => {
    function handleShortcutRecording(e: KeyboardEvent) {
      if (!recordingShortcut) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setRecordingShortcut(null);
        setShortcutError("");
        return;
      }

      if (e.repeat) return;

      const nextShortcut = keyboardEventToShortcut(e);
      if (!nextShortcut) return;

      e.preventDefault();
      e.stopPropagation();

      const oldToggle = shortcut;
      const oldAssist = assistShortcut;

      const nextToggle = recordingShortcut === "toggle" ? nextShortcut : oldToggle;
      const nextAssist = recordingShortcut === "assist" ? nextShortcut : oldAssist;

      if (nextToggle === nextAssist) {
        setShortcutError("That shortcut is already in use.");
        return;
      }

      setShortcutError("");

      invoke("set_global_shortcuts", {
        toggleShortcut: nextToggle,
        assistShortcut: nextAssist,
        fallbackToggleShortcut: oldToggle,
        fallbackAssistShortcut: oldAssist,
      })
        .then(() => {
          if (recordingShortcut === "toggle") {
            setShortcut(nextToggle);
            localStorage.setItem("clickr-global-shortcut", nextToggle);
          } else {
            setAssistShortcut(nextAssist);
            localStorage.setItem("clickr-assist-shortcut", nextAssist);
          }

          setRecordingShortcut(null);
          setShortcutError("");

          void appWindow.emit("settings-updated", {
            forceScreenshot,
          });
        })
        .catch((error) => {
          console.error("Failed to register shortcut:", error);
          setShortcutError("That shortcut is unavailable.");
        });
    }

    window.addEventListener("keydown", handleShortcutRecording, true);

    return () => {
      window.removeEventListener("keydown", handleShortcutRecording, true);
    };
  }, [recordingShortcut, shortcut, assistShortcut, forceScreenshot, appWindow]);

  async function replayOnboarding() {
    if (session.user_id) localStorage.removeItem(onboardingKey(session.user_id));

    await appWindow.emit("settings-updated", {
      forceScreenshot,
      replayOnboarding: true,
    });

    await appWindow.close();
  }


  function loadMemories() {
    invoke<{ id: string; content: string }[]>("list_memories").then(setMemories).catch(() => setMemories([]));
  }

  useEffect(() => {
    loadMemories();
  }, []);

  async function addMemory() {
    setMemoryError("");
    try {
      await invoke("add_memory", { content: memoryText });
      setMemoryText("");
      loadMemories();
    } catch (e) {
      setMemoryError(String(e));
    }
  }

  async function removeMemory(id: string) {
    await invoke("delete_memory", { id }).catch((e) => setMemoryError(String(e)));
    loadMemories();
  }

  function startRecording(which: "toggle" | "assist") {
    setShortcutError("");
    setRecordingShortcut(which);
  }

  return (
    <main className="clickr-root settings-window-root">
      <section className="settings-window-panel settings-window-panel-v2">
        <div
          className="settings-header settings-drag-handle"
          onMouseDown={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest("button, input, textarea, select")) return;
            void appWindow.startDragging();
          }}
        >
          <div>
            <div className="settings-title">Settings</div>
            <div className="settings-subtitle">Customize Clickr</div>
          </div>

          <button
            className="settings-close"
            type="button"
            onClick={() => void appWindow.close()}
            aria-label="Close settings"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="settings-scroll">
          <div className="settings-card">
            <SectionHeader icon="brain" title="Memory" />

            {(
              <>
                <div className="model-locked-text" style={{ marginBottom: 8 }}>
                  Tip: type "remember …" in the chat to save something.
                </div>
                {memories.length > 0 && (
                  <div className="model-list">
                    {memories.map((m) => (
                      <div className="model-item" key={m.id}>
                        <div className="model-item-text">
                          <div className="model-item-name" style={{ whiteSpace: "normal" }}>{m.content}</div>
                        </div>
                        <button className="settings-pill-button" type="button" onClick={() => void removeMemory(m.id)}>
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="model-form">
                  <input
                    className="model-input"
                    placeholder="Something for Clickr to remember"
                    value={memoryText}
                    maxLength={500}
                    onChange={(e) => setMemoryText(e.target.value)}
                  />
                  <button
                    className="settings-pill-button settings-pill-accent"
                    type="button"
                    disabled={!memoryText.trim()}
                    onClick={() => void addMemory()}
                  >
                    Save memory
                  </button>
                </div>
              </>
            )}
            {memoryError && <div className="shortcut-error">{memoryError}</div>}
          </div>

          <div className="settings-card">
            <SectionHeader icon="brain" title="AI model" />
            <div className="model-locked-text" style={{ marginBottom: 8 }}>
              Clickr runs a free open model on your computer with Ollama. Nothing you ask leaves your Mac.
            </div>
            <div className="settings-info-row">
              <span>{ollama.active ? ollama.active : "No model chosen yet"}</span>
              <button className="settings-pill-button settings-pill-accent" type="button" onClick={() => void openAiSetup()}>
                {ollama.active ? "Change" : "Set up"}
              </button>
            </div>
          </div>

          <div className="settings-card">
            <SectionHeader icon="sliders" title="Agent Mode" />
            <div className="settings-info-row">
              <span>Auto-approve agent actions (experimental)</span>
              <button
                className="settings-pill-button"
                type="button"
                onClick={() => {
                  const next = !autoApprove;
                  setAutoApprove(next);
                  localStorage.setItem("clickr-auto-approve", String(next));
                }}
              >
                {autoApprove ? "On" : "Off"}
              </button>
            </div>

            <div className="settings-info-row">
              <span>Agent never touches my mouse (experimental)</span>
              <button
                className="settings-pill-button"
                type="button"
                onClick={() => {
                  const next = !bgInput;
                  setBgInput(next);
                  localStorage.setItem("clickr-agent-background-input", String(next));
                }}
              >
                {bgInput ? "On" : "Off"}
              </button>
            </div>

          </div>

          <div className="settings-card">
            <SectionHeader icon="keyboard" title="Keyboard Shortcuts" />

            <div className="settings-shortcut-row">
              <div>
                <div className="settings-row-title">Show / Hide Clickr</div>
                <div className="settings-row-description">Global shortcut</div>
              </div>

              <button
                className={`shortcut-record-button ${recordingShortcut === "toggle" ? "recording" : ""}`}
                type="button"
                onClick={() => startRecording("toggle")}
              >
                {recordingShortcut === "toggle" ? "Press keys…" : shortcutDisplay(shortcut)}
              </button>
            </div>

            <div className="settings-shortcut-row">
              <div>
                <div className="settings-row-title">Assist</div>
                <div className="settings-row-description">Screenshot + AI assistance</div>
              </div>

              <button
                className={`shortcut-record-button ${recordingShortcut === "assist" ? "recording" : ""}`}
                type="button"
                onClick={() => startRecording("assist")}
              >
                {recordingShortcut === "assist" ? "Press keys…" : shortcutDisplay(assistShortcut)}
              </button>
            </div>

            {recordingShortcut && (
              <div className="shortcut-recording-hint">Press your desired combination. Press Esc to cancel.</div>
            )}

            {shortcutError && <div className="shortcut-error">{shortcutError}</div>}
          </div>

          <div className="settings-card">
            <SectionHeader icon="sliders" title="General" />

            <div className="settings-info-row">
              <span>
                {updateState === "uptodate"
                  ? "You're up to date"
                  : updateState === "available"
                    ? `Version ${pendingUpdate?.version} is available`
                    : updateState === "error"
                      ? "Couldn't check for updates"
                      : updateState === "installing"
                        ? "Installing…"
                        : "Software update"}
              </span>
              <button
                className={`settings-pill-button ${updateState === "available" ? "settings-pill-accent" : ""}`}
                type="button"
                disabled={updateState === "checking" || updateState === "installing"}
                onClick={() => void (updateState === "available" ? installUpdate() : checkUpdates())}
              >
                {updateState === "checking"
                  ? "Checking…"
                  : updateState === "available"
                    ? "Install & restart"
                    : updateState === "installing"
                      ? "…"
                      : "Check now"}
              </button>
            </div>

            <div className="settings-info-row">
              <span>Open Clickr at login</span>
              <button className="settings-pill-button" type="button" onClick={() => void toggleOpenAtLogin()}>
                {openAtLogin ? "On" : "Off"}
              </button>
            </div>

            <button className="settings-row" type="button" onClick={replayOnboarding}>
              <div>
                <div className="settings-row-title">Replay onboarding</div>
                <div className="settings-row-description">Walk through Clickr's features again</div>
              </div>
              <Icon name="chevron" size={14} />
            </button>
          </div>

          <div className="settings-card">
            <SectionHeader icon="bug" title="Support" />

            <button className="settings-row" type="button" onClick={() => reportProblem("settings")}>
              <div>
                <div className="settings-row-title">Report a bug</div>
                <div className="settings-row-description">Something broken or not working? Open an issue on GitHub</div>
              </div>
              <Icon name="chevron" size={14} />
            </button>

            <button className="settings-row" type="button" onClick={() => void openUrl("https://github.com/JustEhannn/clickr")}>
              <div>
                <div className="settings-row-title">Open source on GitHub</div>
                <div className="settings-row-description">Read the code, report issues, or contribute</div>
              </div>
              <Icon name="chevron" size={14} />
            </button>
          </div>

          <div className="settings-footer">
            <span>Clickr AI</span>
            <span>•</span>
            <span>{version ? `v${version}` : ""}</span>
          </div>
        </div>
      </section>
    </main>
  );
}