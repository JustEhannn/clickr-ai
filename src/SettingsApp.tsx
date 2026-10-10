import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { canUse, type Feature } from "./tiers";
import { onboardingKey } from "./storage";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { reportProblem } from "./bugReport";

const SUPPORT_EMAIL = "clickraisupport@gmail.com";

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

type Subscription = {
  tier: "free" | "pro" | "pro_plus";
  status: string;
  billing_cycle: string | null;
  current_period_end: string | null;
};

type CustomModel = {
  id: string;
  name: string;
  provider: string;
  model_id: string;
  base_url: string | null;
};

const PROVIDERS: { value: string; label: string; modelHint: string }[] = [
  { value: "openai", label: "OpenAI", modelHint: "gpt-4o" },
  { value: "anthropic", label: "Anthropic", modelHint: "claude-sonnet-4-6" },
  { value: "gemini", label: "Google Gemini", modelHint: "gemini-3.1-pro-preview" },
  { value: "openai_compatible", label: "OpenAI-compatible (custom URL)", modelHint: "meta-llama/llama-3.3-70b" },
];

type LinkedIdentity = {
  id: string;
  provider: string;
};

function tierLabel(tier: string) {
  if (tier === "pro") return "Pro";
  if (tier === "pro_plus") return "Pro+";
  return "Free";
}

function formatRenewalDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

/** The official four-colour Google "G". */
function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.9-2.26 5.36-4.78 7.02l7.73 6c4.51-4.18 7.09-10.36 7.09-17.49z" />
      <path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24 24 0 0 0 0 21.56l7.98-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.9l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
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

  const [session, setSession] = useState<{ email: string | null; signed_in: boolean; user_id?: string | null }>({
    email: null,
    signed_in: false,
  });

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [linkedProviders, setLinkedProviders] = useState<LinkedIdentity[] | null>(null);
  const [linkError, setLinkError] = useState("");
  const [billingError, setBillingError] = useState("");
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
  const [linkBusy, setLinkBusy] = useState(false);

  const [memories, setMemories] = useState<{ id: string; content: string }[]>([]);
  const [memoryText, setMemoryText] = useState("");
  const [memoryError, setMemoryError] = useState("");

  const [models, setModels] = useState<CustomModel[]>([]);
  const [modelError, setModelError] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [modelName, setModelName] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [modelProvider, setModelProvider] = useState("openai");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [bgInput, setBgInput] = useState(() => localStorage.getItem("clickr-agent-background-input") === "true");
  const [autoApprove, setAutoApprove] = useState(() => localStorage.getItem("clickr-auto-approve") === "true");

  useEffect(() => {
    function loadSubscription() {
      invoke<Subscription>("get_subscription").then(setSubscription).catch(() => setSubscription(null));
    }

    loadSubscription();

    let cleanup: (() => void) | undefined;
    appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) loadSubscription();
    }).then((fn) => {
      cleanup = fn;
    });
    void listen("subscription-updated", () => loadSubscription());
    return () => cleanup?.();
  }, [appWindow]);

  useEffect(() => {
    invoke<{ email: string | null; signed_in: boolean }>("get_session").then(setSession);

    let cleanup: (() => void) | undefined;
    void listen<{ email: string | null; signed_in: boolean }>("session-updated", (event) => {
      setSession(event.payload);
    }).then((fn) => {
      cleanup = fn;
    });

    return () => cleanup?.();
  }, []);

  function loadLinkedProviders() {
    invoke<LinkedIdentity[]>("get_linked_providers")
      .then(setLinkedProviders)
      .catch(() => setLinkedProviders(null));
  }

  useEffect(() => {
    loadLinkedProviders();

    let cleanup: (() => void) | undefined;
    appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) loadLinkedProviders();
    }).then((fn) => {
      cleanup = fn;
    });

    return () => cleanup?.();
  }, [appWindow]);

  async function linkGoogle() {
    setLinkError("");
    setLinkBusy(true);
    try {
      await invoke("start_link_google");
    } catch (e) {
      setLinkError(String(e));
    } finally {
      setLinkBusy(false);
    }
  }

  async function unlinkGoogle(identityId: string) {
    setLinkError("");
    setLinkBusy(true);
    try {
      await invoke("unlink_provider", { identityId });
      loadLinkedProviders();
    } catch (e) {
      setLinkError(String(e));
    } finally {
      setLinkBusy(false);
    }
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

  const tierNow = subscription?.tier ?? "free";
  const modelsUnlocked = canUse(subscription?.tier ?? null, "customModels");
  const hotkeysUnlocked = canUse(subscription?.tier ?? null, "customHotkeys");

  const memoryUnlocked = canUse(subscription?.tier ?? null, "memory");

  function loadMemories() {
    invoke<{ id: string; content: string }[]>("list_memories").then(setMemories).catch(() => setMemories([]));
  }

  useEffect(() => {
    if (memoryUnlocked) loadMemories();
  }, [memoryUnlocked]);

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

  function loadModels() {
    invoke<CustomModel[]>("list_custom_models").then(setModels).catch(() => setModels([]));
  }

  useEffect(() => {
    if (modelsUnlocked) loadModels();
  }, [modelsUnlocked]);

  async function addModel() {
    setModelError("");
    setModelBusy(true);
    try {
      await invoke("add_custom_model", {
        name: modelName,
        provider: modelProvider,
        modelId,
        apiKey: modelKey,
        baseUrl: modelProvider === "openai_compatible" ? modelBaseUrl : null,
      });
      setModelName("");
      setModelId("");
      setModelKey("");
      setModelBaseUrl("");
      loadModels();
      void emit("models-updated");
    } catch (e) {
      setModelError(String(e));
    } finally {
      setModelBusy(false);
    }
  }

  async function removeModel(id: string) {
    setModelError("");
    try {
      await invoke("delete_custom_model", { id });
      loadModels();
      void emit("models-updated");
    } catch (e) {
      setModelError(String(e));
    }
  }

  function startRecording(which: "toggle" | "assist") {
    if (!hotkeysUnlocked) {
      void openPricingModal("customHotkeys");
      return;
    }
    setShortcutError("");
    setRecordingShortcut(which);
  }

  async function openPricingModal(feature?: Feature) {
    await emit("open-pricing-modal", { feature });
    await appWindow.close();
  }

  const hasGoogle = linkedProviders?.some((p) => p.provider === "google") ?? false;
  const googleIdentity = linkedProviders?.find((p) => p.provider === "google");

  const tier = subscription?.tier ?? "free";
  const tierBadgeClass =
    tier === "pro_plus" ? "settings-tier-badge tier-pro-plus" : tier === "pro" ? "settings-tier-badge tier-pro" : "settings-tier-badge";

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
            <SectionHeader icon="user" title="Account" />

            <div className="settings-account-row">
              <div className="settings-avatar">{(session.email ?? "?").charAt(0).toUpperCase()}</div>
              <div className="settings-account-info">
                <div className="settings-account-email">{session.email ?? "Signed in"}</div>
                <span className={tierBadgeClass}>{tierLabel(tier)}</span>
              </div>
              <button className="settings-pill-button" type="button" onClick={() => void invoke("sign_out")}>
                Sign Out
              </button>
            </div>

            <div className="settings-divider-thin" />

            {hasGoogle ? (
              <div className="google-linked-row">
                <div className="google-button google-button-static">
                  <GoogleLogo />
                  <span>Google account linked</span>
                  <span className="google-check" aria-hidden="true">✓</span>
                </div>
                <button
                  className="google-unlink"
                  type="button"
                  disabled={linkBusy}
                  onClick={() => googleIdentity && void unlinkGoogle(googleIdentity.id)}
                >
                  {linkBusy ? "…" : "Unlink"}
                </button>
              </div>
            ) : (
              <button className="google-button" type="button" disabled={linkBusy} onClick={() => void linkGoogle()}>
                <GoogleLogo />
                <span>{linkBusy ? "Opening…" : "Link Google account"}</span>
              </button>
            )}

            {linkError && <div className="shortcut-error">{linkError}</div>}
          </div>

          <div className="settings-card">
            <SectionHeader icon="card" title="Billing" />

            <div className="settings-info-row">
              <span>Current Plan</span>
              <span className={tierBadgeClass}>{subscription ? tierLabel(subscription.tier) : "…"}</span>
            </div>

            {subscription && subscription.tier !== "free" && subscription.current_period_end && (
              <div className="settings-info-row">
                <span>Renews</span>
                <span className="settings-value-text">
                  {formatRenewalDate(subscription.current_period_end)}
                  {subscription.billing_cycle ? ` · ${subscription.billing_cycle}` : ""}
                </span>
              </div>
            )}

            {subscription?.tier === "free" && (
              <button className="settings-row" type="button" onClick={() => void openPricingModal()}>
                <div>
                  <div className="settings-row-title">Upgrade to Pro</div>
                  <div className="settings-row-description">View plans</div>
                </div>
                <Icon name="chevron" size={14} />
              </button>
            )}

            {subscription?.tier === "pro" && (
              <button className="settings-row" type="button" onClick={() => void openPricingModal()}>
                <div>
                  <div className="settings-row-title">Upgrade to Pro+</div>
                  <div className="settings-row-description">Agent Mode, custom models, highest limits</div>
                </div>
                <Icon name="chevron" size={14} />
              </button>
            )}

            {subscription?.tier === "pro_plus" && (
              <div className="settings-info-row">
                <span>You're on our top plan</span>
              </div>
            )}

            {subscription && subscription.tier !== "free" && (
              <>
              <button
                className="settings-row"
                type="button"
                onClick={() => {
                  setBillingError("");
                  // Billing (cancel, switch plan, card, receipts) lives on the website.
                  openUrl("https://www.clickrai.com/account#billing").catch(() =>
                    setBillingError("Couldn't open your browser. Go to clickrai.com/account."),
                  );
                }}
              >
                <div>
                  <div className="settings-row-title">Manage subscription</div>
                  <div className="settings-row-description">Cancel, switch plans, or update payment</div>
                </div>
                <Icon name="chevron" size={14} />
              </button>
              {billingError && <div className="shortcut-error">{billingError}</div>}
              </>
            )}
          </div>

          <div className="settings-card">
            <SectionHeader icon="brain" title="Memory" />

            {!memoryUnlocked ? (
              <div className="model-locked">
                <div className="model-locked-text">
                  Clickr remembers things you tell it across conversations. Available on Pro.
                </div>
                <button
                  className="settings-pill-button settings-pill-accent"
                  type="button"
                  onClick={() => void openPricingModal("memory")}
                >
                  Upgrade
                </button>
              </div>
            ) : (
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
            <SectionHeader icon="brain" title="AI" />

            {!modelsUnlocked ? (
              <div className="model-locked">
                <div className="model-locked-text">
                  Use your own AI models inside Clickr — OpenAI, Anthropic, Gemini or any OpenAI-compatible API — and switch between them from the chat header. Available on Pro+.
                </div>
                <button
                  className="settings-pill-button settings-pill-accent"
                  type="button"
                  onClick={() => void openPricingModal("customModels")}
                >
                  {tierNow === "free" ? "Upgrade" : "Get Pro+"}
                </button>
              </div>
            ) : (
              <>
                {models.length > 0 && (
                  <div className="model-list">
                    {models.map((m) => (
                      <div className="model-item" key={m.id}>
                        <div className="model-item-text">
                          <div className="model-item-name">{m.name}</div>
                          <div className="model-item-meta">{PROVIDERS.find((p) => p.value === m.provider)?.label ?? m.provider} · {m.model_id}</div>
                        </div>
                        <button className="settings-pill-button" type="button" onClick={() => void removeModel(m.id)}>
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="model-locked-text" style={{ marginBottom: 8 }}>
                  Add models here, then pick one from the Clickr AI menu at the top of the chat.
                </div>
                <div className="model-form">
                  <select
                    className="model-input"
                    value={modelProvider}
                    onChange={(e) => setModelProvider(e.target.value)}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {modelProvider === "openai_compatible" && (
                    <input
                      className="model-input"
                      placeholder="Base URL (https://…/v1)"
                      value={modelBaseUrl}
                      onChange={(e) => setModelBaseUrl(e.target.value)}
                    />
                  )}
                  <input
                    className="model-input"
                    placeholder="Display name"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                  />
                  <input
                    className="model-input"
                    placeholder={`Model ID (e.g. ${PROVIDERS.find((p) => p.value === modelProvider)?.modelHint})`}
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                  />
                  <input
                    className="model-input"
                    type="password"
                    placeholder="API key"
                    value={modelKey}
                    onChange={(e) => setModelKey(e.target.value)}
                  />
                  <button
                    className="settings-pill-button settings-pill-accent"
                    type="button"
                    disabled={modelBusy || !modelName.trim() || !modelId.trim() || !modelKey.trim() || (modelProvider === "openai_compatible" && !modelBaseUrl.trim())}
                    onClick={() => void addModel()}
                  >
                    {modelBusy ? "Adding…" : "Add model"}
                  </button>
                </div>
              </>
            )}

            {modelError && <div className="shortcut-error">{modelError}</div>}
          </div>

          <div className="settings-card">
            <SectionHeader icon="sliders" title="Pro+" />
            <div className="settings-info-row">
              <span>
                Beta: auto-approve agent actions{" "}
                {!canUse(subscription?.tier ?? null, "beta") && <span className="settings-lock-chip">Pro+</span>}
              </span>
              <button
                className="settings-pill-button"
                type="button"
                onClick={() => {
                  if (!canUse(subscription?.tier ?? null, "beta")) {
                    void openPricingModal("beta");
                    return;
                  }
                  const next = !autoApprove;
                  setAutoApprove(next);
                  localStorage.setItem("clickr-auto-approve", String(next));
                }}
              >
                {autoApprove && canUse(subscription?.tier ?? null, "beta") ? "On" : "Off"}
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

            <button
              className="settings-row"
              type="button"
              onClick={() => {
                const pro = canUse(subscription?.tier ?? null, "prioritySupport");
                void openUrl(
                  `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(pro ? "[Priority] Clickr support" : "Clickr support")}`,
                );
              }}
            >
              <div>
                <div className="settings-row-title">
                  {canUse(subscription?.tier ?? null, "prioritySupport") ? "Priority Support" : "Contact support"}
                </div>
                <div className="settings-row-description">
                  {canUse(subscription?.tier ?? null, "prioritySupport")
                    ? "Your emails are flagged and answered first"
                    : "Upgrade to Pro+ for priority replies"}
                </div>
              </div>
              <Icon name="chevron" size={14} />
            </button>
          </div>

          <div className="settings-card">
            <SectionHeader icon="keyboard" title="Keyboard Shortcuts" />

            <div className="settings-shortcut-row">
              <div>
                <div className="settings-row-title">Show / Hide Clickr</div>
                <div className="settings-row-description">{hotkeysUnlocked ? "Global shortcut" : "Custom hotkeys require Pro"}</div>
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
                <div className="settings-row-description">Something broken or not working? Tell us — we read every report</div>
              </div>
              <Icon name="chevron" size={14} />
            </button>
          </div>

          <div className="settings-footer">
            <span>Clickr</span>
            <span>•</span>
            <span>{version ? `v${version}` : ""}</span>
          </div>
        </div>
      </section>
    </main>
  );
}