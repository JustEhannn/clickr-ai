import {
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { emit, listen } from "@tauri-apps/api/event";
import clickrLogoTransparent from "./assets/clickr-logo-transparent.png";
import clickrLogoFull from "./assets/clickr-logo-full.png";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import PricingModal from "./PricingModal";
import { agentBetaKey, onboardingKey } from "./storage";
import { reportProblem } from "./bugReport";
import { canUse, canAttachFile, FILE_ACCEPT_ALL, type Feature, type Tier } from "./tiers";
import {
  describeCall,
  endsBatch,
  needsApproval,
  parseElementList,
  usesComputerControl,
  type AgentCall,
} from "./agent";

import "katex/dist/katex.min.css";

type Attachment = { dataUrl: string; name?: string };

type Message = {
  role: "user" | "assistant";
  text: string;
  isError?: boolean;
  /** Older saved chats stored a single attachment in these two fields. */
  imageDataUrl?: string;
  fileName?: string;
  attachments?: Attachment[];
  /** Agent Mode progress line (not part of the conversation sent to the AI). */
  kind?: "step";
  stepId?: string;
  stepStatus?: "running" | "done" | "error" | "denied";
  /** Automated limit reply on the Free plan: show an Upgrade button. */
  upgradeCta?: boolean;
  /** An agent step line that is the model's own commentary rather than an action. */
  isNote?: boolean;
  /** Set while an answer is still arriving word by word. */
  streamId?: string;
  streaming?: boolean;
};

type CustomModel = { id: string; name: string; provider: string; model_id: string };
type ApprovalDecision = "approve" | "approve_all" | "deny" | "stop";


// Elements that make up the clickable UI. Everything else in the window is
// transparent and must let clicks through to the apps behind.
const CLICKABLE_SELECTOR =
  ".cue-toolbar, .cue-panel, .settings-popover, .pricing-modal-overlay, .permissions-overlay, .agent-beta-overlay";

type ChatHistoryEntry = {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  messages: Message[];
};

type Status = "idle" | "looking" | "thinking";

type AIHealth = "unknown" | "healthy" | "error";

type TourStep = {
  target: string;
  title: string;
  description: string;
};

type SpotlightRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type TourCardPosition = {
  top: number;
  left: number;
};

const PERMISSIONS = [
  {
    key: "screen_recording",
    label: "Screen Recording",
    description: "Lets Clickr see your screen when you ask it a question.",
  },
];

const DEFAULT_TOGGLE_SHORTCUT = "CmdOrCtrl+Shift+Space";
const DEFAULT_ASSIST_SHORTCUT = "CmdOrCtrl+Enter";

const HISTORY_STORAGE_KEY = "clickr-chat-history";
const MAX_HISTORY_ENTRIES = 30;

/*
 * Clickr onboarding tour.
 *
 * Smart Mode and Assist are intentionally explained
 * separately so users understand exactly when Clickr
 * uses their screen.
 */
const TOUR_STEPS: TourStep[] = [
  {
    target: "drag",
    title: "Move Clickr",
    description: "Drag the toolbar to move Clickr anywhere on your screen.",
  },
  {
    target: "awareness",
    title: "Screen Awareness",
    description: "This indicator lights up when Clickr is actively viewing your screen.",
  },
  {
    target: "hide",
    title: "Hide Clickr",
    description: "Temporarily hide the main Clickr panel while keeping the toolbar visible.",
  },
  {
    target: "composer",
    title: "Ask Clickr",
    description: "Ask Clickr questions about anything in your conversation or, when needed, what's on your screen.",
  },
  {
    target: "smart",
    title: "Smart Mode",
    description: "By default, Clickr automatically decides when it needs to see your screen. Press this to force every message to include a screenshot, until you turn it off again.",
  },
  {
    target: "settings",
    title: "Settings",
    description: "Customize Clickr, change your AI preferences, and manage your keyboard shortcuts.",
  },
];

function Icon({
  name,
  size = 16,
}: {
  name: "sparkles" | "chevron" | "x" | "history" | "arrow" | "settings" | "image" | "paperclip" | "brain" | "agent" | "bolt" | "check" | "wand" | "plus" | "copy";
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
  
  switch (name) {
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );

    case "copy":
      return (
        <svg {...common}>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </svg>
      );

    case "wand":
      return (
        <svg {...common}>
          <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z" />
          <path d="m14 7 3 3" />
          <path d="M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9" />
        </svg>
      );

    case "agent":
      return (
        <svg {...common}>
          <path d="M9 9l5.5 12 1.9-5.1L21.5 14 9 9z" />
          <path d="M5.5 3.5 7 6M3 8.5l2.8 1M11 2.5 10.4 5.6" />
        </svg>
      );

    case "bolt":
      return (
        <svg {...common}>
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
      );

    case "check":
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );

    case "paperclip":
      return (
        <svg {...common}>
          <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95L10.13 17.1a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      );

    case "brain":
      return (
        <svg {...common}>
          <path d="M9.5 2a2.5 2.5 0 0 0-2.5 2.5v.6A3.5 3.5 0 0 0 4 8.5v1A3.5 3.5 0 0 0 3 12a3.5 3.5 0 0 0 1 2.5v1A3.5 3.5 0 0 0 7 19h.1a2.5 2.5 0 0 0 4.9-.7V4.5A2.5 2.5 0 0 0 9.5 2z" />
          <path d="M14.5 2a2.5 2.5 0 0 1 2.5 2.5v.6A3.5 3.5 0 0 1 20 8.5v1a3.5 3.5 0 0 1 1 2.5 3.5 3.5 0 0 1-1 2.5v1a3.5 3.5 0 0 1-3 3.46 2.5 2.5 0 0 1-4.9-.66V4.5A2.5 2.5 0 0 1 14.5 2z" />
        </svg>
      );

    case "image":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      );

    case "sparkles":
      return (
        <svg {...common}>
          <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063L2.365 12.48a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z" />
          <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
        </svg>
      );

    case "chevron":
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );

    case "x":
      return (
        <svg {...common}>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      );

    case "history":
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      );

    case "settings":
      return (
        <svg {...common}>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );

    default:
      return (
        <svg {...common}>
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </svg>
      );
  }
}


/*
 * Detect requests that clearly depend on visual context.
 *
 * Smart Mode uses this before requesting a screenshot.
 */
function questionNeedsScreenshot(question: string) {
  const q = question.toLowerCase().replace(/\s+/g, " ").trim();

  const visualPatterns = [
    /\bwhat(?:'s| is) (?:on|in) (?:my|the) screen\b/,
    /\bwhat does (?:this|that) (?:say|mean|show)\b/,
    /\blook at (?:this|my|the) screen\b/,
    /\blook at this\b/,
    /\bcan you see\b/,
    /\bwhat am i looking at\b/,
    /\bwhat(?:'s| is) wrong with (?:this|my) (?:screen|code|error)\b/,
    /\bwhy (?:is|isn't|doesn't) (?:this|it) work\b/,
    /\bfix (?:this|that) (?:error|problem|code|issue)\b/,
    /\bdebug (?:this|that|my) (?:code|error|issue)\b/,
    /\bexplain (?:this|that) (?:error|code|problem)\b/,
    /\bsolve (?:this|that) (?:problem|question|equation)\b/,
    /\bhelp me with (?:this|that)\b/,
    /\bwhat should i (?:click|do|press)\b/,
    /\bwhich button\b/,
    /\bwhere (?:do|should) i click\b/,
    /\bwhat(?:'s| is) this\b/,
    /\bread (?:this|the) (?:screen|error|message)\b/,
    /\bwhat(?:'s| is) happening\b/,
    /\breview (?:this|my)\b/,
    /\bcheck (?:this|my)\b/,
    /\banalyze (?:this|my)\b/,
    /\bsummarize (?:this|my)\b/,
    /\btranslate this\b/,
    /\bwhat(?:'s| is) in front of me\b/,
    /\bwhat file\b/,
    /\bwhat tab\b/,
    /\bwhat window\b/,
    /\bwhat app(?:lication)?\b/,
  ];

  return visualPatterns.some((pattern) => pattern.test(q));
}

/*
 * Web search is quota-limited per plan, so only ask for it when the question
 * is plainly about something live or external.
 */
function questionNeedsWeb(question: string) {
  const q = question.toLowerCase();
  return [
    /\b(latest|news|today|tonight|yesterday|tomorrow|this (?:week|month|year)|right now|currently|recent(?:ly)?)\b/,
    /\b(price|stock|weather|forecast|score|standings|release date|exchange rate|trending)\b/,
    /\b(who won|who is the (?:current|new)|what happened)\b/,
    /\b(search|look up|google|browse the web|find online)\b/,
    /https?:\/\/|www\./,
  ].some((r) => r.test(q));
}

// History is stored per account. (It used to be one shared key, so a second account on the
// same Mac could see the first one's conversations.)
const historyKey = (userId: string) => `${HISTORY_STORAGE_KEY}:${userId}`;

function loadChatHistory(userId: string | null): ChatHistoryEntry[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(historyKey(userId));
    return raw ? (JSON.parse(raw) as ChatHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveChatHistory(entries: ChatHistoryEntry[], userId: string | null) {
  if (!userId) return;
  try {
    localStorage.setItem(
      historyKey(userId),
      JSON.stringify(entries.slice(0, MAX_HISTORY_ENTRIES)),
    );
  } catch {
    // Ignore storage errors (e.g. quota exceeded)
  }
}

function makeSafeClickHandlers(
  posRef: React.MutableRefObject<{ x: number; y: number } | null>,
  onClick: () => void,
) {
  return {
    onMouseDown: (e: React.MouseEvent) => {
      posRef.current = { x: e.clientX, y: e.clientY };
    },
    onMouseUp: (e: React.MouseEvent) => {
      const down = posRef.current;
      posRef.current = null;
      if (!down) return;
      const dx = Math.abs(e.clientX - down.x);
      const dy = Math.abs(e.clientY - down.y);
      if (dx <= 4 && dy <= 4) onClick();
    },
  };
}

function titleFromMessage(text: string) {
  const words = text.trim().split(/\s+/).slice(0, 4);
  return words.join(" ") || "New chat";
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** "2 hrs 15 mins", "1 hr", "40 mins" */
function formatReset(ms: number) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const h = hours > 0 ? `${hours} ${hours === 1 ? "hr" : "hrs"}` : "";
  const m = minutes > 0 ? `${minutes} ${minutes === 1 ? "min" : "mins"}` : "";
  return [h, m].filter(Boolean).join(" ");
}

type Memory = { id: string; content: string };

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function getDeviceId(): string {
  try {
    let id = localStorage.getItem("clickr-device-id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("clickr-device-id", id);
    }
    return id;
  } catch {
    return "unknown-device";
  }
}

/** True when the last actions are the same short sequence repeated three times. */
function isCycle(actions: string[]) {
  for (const period of [2, 3, 4]) {
    const n = period * 3;
    if (actions.length < n) continue;
    const tail = actions.slice(-n);
    if (tail.every((a, i) => a === tail[i % period]) && new Set(tail.slice(0, period)).size > 1) return true;
  }
  return false;
}

/** Cheap fingerprint of a screenshot (samples the data, not every byte). */
function hashShot(data: string) {
  let h = 5381;
  const step = Math.max(1, Math.floor(data.length / 4000));
  for (let i = 0; i < data.length; i += step) h = ((h << 5) + h + data.charCodeAt(i)) | 0;
  return `${data.length}:${h}`;
}

export default function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<Status>("idle");

  const [forceScreenshot, setForceScreenshot] = useState(
    () => localStorage.getItem("clickr-force-screenshot") === "true",
  );

  const [panelVisible, setPanelVisible] = useState(true);
  const [aiHealth, setAiHealth] = useState<AIHealth>("unknown");
  const [screenRecordingGranted, setScreenRecordingGranted] = useState<boolean | null>(null);


  const [shortcut] = useState(
    () => localStorage.getItem("clickr-global-shortcut") || DEFAULT_TOGGLE_SHORTCUT,
  );

  const [assistShortcut] = useState(
    () => localStorage.getItem("clickr-assist-shortcut") || DEFAULT_ASSIST_SHORTCUT,
  );
  

  const [currentTier, setCurrentTier] = useState<Tier | null>(null);
  const effectiveTier: Tier = currentTier ?? "free";
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tourActive, setTourActive] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [spotlight, setSpotlight] = useState<SpotlightRect | null>(null);
  const [tourCardPosition, setTourCardPosition] = useState<TourCardPosition | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const userIdRef = useRef<string | null>(null);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tourCardRef = useRef<HTMLDivElement>(null);
  const assistHandlerRef = useRef<() => void>(() => {});
  const historyPopoverRef = useRef<HTMLDivElement>(null);

  const [limitReachedUntil, setLimitReachedUntil] = useState<number | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);
  const [pricingModalOpen, setPricingModalOpen] = useState(false);
  const [awaitingPurchase, setAwaitingPurchase] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  const [crashNotice, setCrashNotice] = useState<string | null>(null);
  const [agentBetaOpen, setAgentBetaOpen] = useState(false);
  const [agentAccessStep, setAgentAccessStep] = useState(false);
  const [axGranted, setAxGranted] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ version: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const updateRef = useRef<Update | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [userId, setUserId] = useState<string | null>(null);

  const sessionIdRef = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const [deviceBlocked, setDeviceBlocked] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [agentAllowed, setAgentAllowed] = useState<boolean | null>(null);

  // Pro+ state
  const [pricingFeature, setPricingFeature] = useState<Feature | null>(null);
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem("clickr-selected-model") || "default",
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [reasoningOn, setReasoningOn] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{ call: AgentCall; text: string } | null>(null);
  const approvalResolverRef = useRef<((d: ApprovalDecision) => void) | null>(null);
  const agentCancelRef = useRef(false);
  const askCancelRef = useRef<(() => void) | null>(null);
  const elementIndexRef = useRef<Map<number, string>>(new Map());
  const modelMenuRef = useRef<HTMLDivElement>(null);


  const busy = status !== "idle";
  const hasMessages = messages.length > 0;
  const remainingMs = limitReachedUntil ? limitReachedUntil - nowTick : 0;
  const isLimited = limitReachedUntil !== null && remainingMs > 0;
  const updateClickableRectRef = useRef<() => Promise<void>>(async () => {});
  const clickDownPosRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!limitReachedUntil) return;
    const interval = window.setInterval(() => setNowTick(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, [limitReachedUntil]);

  useEffect(() => {
    if (limitReachedUntil && nowTick >= limitReachedUntil) {
      setLimitReachedUntil(null);
      setBannerDismissed(false);
    }
  }, [nowTick, limitReachedUntil]);

  // Session and plan both depend on sign-in finishing, which happens after
  // this window mounts (the panel is created hidden at launch). Reload both
  // whenever the session changes so we never get stuck on "free"/null user.
  useEffect(() => {
    const loadSession = () =>
      invoke<{ user_id: string | null }>("get_session")
        .then((s) => setUserId(s.user_id))
        .catch(() => {});

    const loadTier = async () => {
      try {
        const subscription = await invoke<{ tier: Tier }>("get_subscription");
        setCurrentTier(subscription.tier);
      } catch (error) {
        console.warn("Couldn't load plan:", error);
        // Signed in but no row / fetch failed → treat as free, but only
        // once we know who we are; otherwise stay "unknown".
        const s = await invoke<{ signed_in: boolean }>("get_session").catch(() => ({ signed_in: false }));
        setCurrentTier(s.signed_in ? "free" : null);
      }
    };

    void loadSession();
    void loadTier();

    const unlisteners = [
      listen("subscription-updated", () => {
        void loadTier();
        // Coming back from the browser (the "Open Clickr" button) ends the waiting state.
        if (uiHiddenRef.current) void restoreAfterPurchaseRef.current();
      }),
      listen("session-updated", () => {
        void loadSession();
        void loadTier();
      }),
    ];

    return () => {
      unlisteners.forEach((p) => void p.then((fn) => fn()));
    };
  }, []);

  // While the user pays in the browser the chat is hidden behind a small status pill,
  // so it isn't in the way. This brings everything back.
  async function hideForPurchase() {
    setUiHidden(true);
    await invoke("set_agent_hidden", { hidden: true }).catch(() => {});
    await invoke("agent_bar_show").catch(() => {});
    void emit("agent-status", { text: "Finish upgrading in your browser…", stopLabel: "Back to Clickr" });
  }

  async function restoreAfterPurchase() {
    setAwaitingPurchase(false);
    setUiHidden(false);
    setPricingModalOpen(false);
    setPricingFeature(null);
    setPanelVisible(true);
    await invoke("agent_restore");
  }
  const uiHiddenRef = useRef(false);
  uiHiddenRef.current = uiHidden;
  const restoreAfterPurchaseRef = useRef(restoreAfterPurchase);
  restoreAfterPurchaseRef.current = restoreAfterPurchase;

  // After sending the user to the website to pay, watch for the new plan so the app
  // unlocks within seconds of the payment instead of waiting for a restart.
  useEffect(() => {
    if (!awaitingPurchase) return;
    const startedWith = currentTier;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > 20 * 60_000) {
        void restoreAfterPurchaseRef.current();
        return;
      }
      invoke<{ tier: Tier }>("get_subscription")
        .then((sub) => {
          if (sub.tier !== startedWith) {
            setCurrentTier(sub.tier);
            void restoreAfterPurchaseRef.current();
          }
        })
        .catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingPurchase]);

  // Re-check the plan every time the pricing modal opens, so "Current Plan"
  // is never stale.
  useEffect(() => {
    if (!pricingModalOpen) return;
    invoke<{ tier: Tier }>("get_subscription")
      .then((sub) => setCurrentTier(sub.tier))
      .catch(() => {});
  }, [pricingModalOpen]);

  useEffect(() => {
    // Sends the clickable area RELATIVE to the window. The native side adds the
    // window's live position every time, so it can never go stale when the
    // pill is dragged somewhere else.
    async function updateClickableRect() {
      try {
        const elements = document.querySelectorAll(CLICKABLE_SELECTOR);

        if (elements.length === 0) {
          await invoke("update_clickable_rect", { x: 0, y: 0, width: 0, height: 0 });
          return;
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        elements.forEach((el) => {
          const rect = el.getBoundingClientRect();
          minX = Math.min(minX, rect.left);
          minY = Math.min(minY, rect.top);
          maxX = Math.max(maxX, rect.right);
          maxY = Math.max(maxY, rect.bottom);
        });

        await invoke("update_clickable_rect", {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
        });
      } catch (error) {
        console.error("Failed to update clickable rect:", error);
      }
    }
    updateClickableRectRef.current = updateClickableRect;
    void updateClickableRect();

    // Streaming text mutates the page many times a second; coalesce to one update per frame.
    let rectQueued = false;
    const scheduleRect = () => {
      if (rectQueued) return;
      rectQueued = true;
      requestAnimationFrame(() => {
        rectQueued = false;
        void updateClickableRect();
      });
    };
    const observer = new MutationObserver(scheduleRect);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });

    const resizeObserver = new ResizeObserver(scheduleRect);
    resizeObserver.observe(document.body);

    // The native mouse monitor only sees moves over OTHER apps, so it can't
    // notice the cursor drifting onto a transparent part of our own window
    // (e.g. where the chat panel was before Hide). Events over our window
    // reach us here, so this is what makes those areas click-through.
    let frame = 0;
    const onMouseMove = (e: MouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Same union box the native side uses (see updateClickableRect), so the
        // two never disagree and flip-flop.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        document.querySelectorAll(CLICKABLE_SELECTOR).forEach((el) => {
          const r = el.getBoundingClientRect();
          minX = Math.min(minX, r.left);
          minY = Math.min(minY, r.top);
          maxX = Math.max(maxX, r.right);
          maxY = Math.max(maxY, r.bottom);
        });
        const overUi = e.clientX >= minX && e.clientX <= maxX && e.clientY >= minY && e.clientY <= maxY;
        if (!overUi) void invoke("set_click_through", { ignore: true });
      });
    };
    document.addEventListener("mousemove", onMouseMove, { passive: true });

    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("mousemove", onMouseMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  /*
   * Check screen recording permission, live — polls every 1.5s so the
   * status updates automatically the moment it's granted, no restart needed.
   */
    useEffect(() => {
     let cancelled = false;

  // No permission prompt at launch: the permissions screen below walks the user
  // through it, and only then do we ask macOS (see openScreenRecordingSettings).

  async function checkPermission() {
      try {
        const granted = await invoke<boolean>("check_screen_recording_permission");
        if (!cancelled) setScreenRecordingGranted(granted);
      } catch (error) {
        console.error("Failed to check screen recording permission:", error);
      }
    }

    void checkPermission();
    const interval = window.setInterval(checkPermission, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  async function openScreenRecordingSettings() {
    try {
      // Just opens the pane — Clickr never triggers macOS's own prompt itself.
      await invoke("open_system_settings_pane", { pane: "screen_recording" });
    } catch (error) {
      console.error("Failed to open settings pane:", error);
    }
  }

  /*
   * Image drag drop.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDraggingFile(true);
          void invoke("set_drag_active", { active: true });
        } else if (event.payload.type === "drop") {
          setIsDraggingFile(false);
          const path = event.payload.paths[0];
          void invoke("set_drag_active", { active: false });
          if (path) void handleDroppedFile(path);
        } else if (event.payload.type === "leave") {
          setIsDraggingFile(false);
          void invoke("set_drag_active", { active: false });
        }
      })
      .then((cleanup) => {
        unlisten = cleanup;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  /** Opens the pricing modal with a "<feature> is a <plan> feature" banner. */
  function promptUpgrade(feature: Feature | null) {
    setPricingFeature(feature);
    setPanelVisible(true);
    setPricingModalOpen(true);
  }

  const MAX_ATTACHMENTS = 4;

  /** Adds a file to the message. Free accounts get one; Pro and above up to four. */
  function addAttachment(att: Attachment, countAlready = 0): boolean {
    const have = attachmentsRef.current.length + countAlready;
    if (have >= 1 && !canUse(effectiveTier, "multiFile")) {
      promptUpgrade("multiFile");
      return false;
    }
    if (have >= MAX_ATTACHMENTS) {
      setBlockedNotice(`You can attach up to ${MAX_ATTACHMENTS} files at once.`);
      window.setTimeout(() => setBlockedNotice(null), 3000);
      return false;
    }
    setAttachments((prev) => [...prev, att]);
    return true;
  }

  const readDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  async function handleDroppedFile(path: string) {
    if (!canAttachFile(effectiveTier, path)) {
      promptUpgrade("advancedFiles");
      return;
    }
    setUploadProgress(0);

    try {
      setUploadProgress(50);
      const dataUrl = await invoke<string>("read_image_file", { path });
      setUploadProgress(100);
      addAttachment({
        dataUrl,
        name: dataUrl.startsWith("data:image/") ? undefined : path.split(/[\\/]/).pop(),
      });
    } catch (error) {
      console.error("Failed to read dropped file:", error);
    } finally {
      setTimeout(() => setUploadProgress(null), 300);
    }
  }
  
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    void listen<{ feature?: Feature } | null>("open-pricing-modal", (event) => {
      promptUpgrade(event.payload?.feature ?? null);
    }).then((fn) => {
      cleanup = fn;
    });

    return () => cleanup?.();
  }, []);


  /*
   * Startup / onboarding — waits until screen recording is actually
   * granted, since walking someone through features that won't work yet
   * isn't useful.
   */
  useEffect(() => {
    // Needs a signed-in account (the guide is remembered per account) and a visible panel.
    if (screenRecordingGranted !== true || !userId || !panelVisible) return;

    const completed = localStorage.getItem(onboardingKey(userId)) === "true";

    if (!completed) {
      const timer = window.setTimeout(() => {
        setTourActive(true);
      }, 700);

      return () => window.clearTimeout(timer);
    }
  }, [screenRecordingGranted, userId, panelVisible]);

  /*
   * AI health.
   */
  useEffect(() => {
    let cancelled = false;

    async function checkAI() {
      try {
        await invoke("check_ai");
        if (!cancelled) setAiHealth("healthy");
      } catch (error) {
        console.warn("AI health check failed:", error);
        // Not signed in yet is not an AI problem; the session event re-runs this.
        if (!cancelled) setAiHealth(error === "not_signed_in" ? "unknown" : "error");
      }
    }

    void checkAI();

    // Re-check once sign-in completes, and every few minutes after.
    const un = listen("session-updated", () => void checkAI());
    const timer = window.setInterval(() => void checkAI(), 5 * 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void un.then((fn) => fn());
    };
  }, []);

  /*
   * Single-device enforcement (Free). Runs once the plan is known.
   */
  useEffect(() => {
    if (!userId) {
      setDeviceBlocked(false);
      return;
    }
    if (currentTier === null) return;
    invoke<boolean>("register_device", { deviceId: getDeviceId(), tier: currentTier })
      .then((allowed) => setDeviceBlocked(!allowed))
      .catch(() => setDeviceBlocked(false));

    // Re-check periodically so a device that was signed out elsewhere notices.
    const timer = window.setInterval(() => {
      invoke<boolean>("register_device", { deviceId: getDeviceId(), tier: currentTier })
        .then((allowed) => setDeviceBlocked(!allowed))
        .catch(() => {});
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [currentTier, userId]);

  async function takeOverDevice() {
    setTakingOver(true);
    try {
      await invoke("take_over_device", { deviceId: getDeviceId() });
      setDeviceBlocked(false);
    } catch (e) {
      console.warn("Take-over failed:", e);
    } finally {
      setTakingOver(false);
    }
  }

  /*
   * Conversation history sync across devices (Pro): merge what's in the
   * cloud into local history whenever we learn the user is Pro.
   */
  const syncsHistory = canUse(effectiveTier, "historySync");
  useEffect(() => {
    if (!syncsHistory || !userId) return;
    invoke<ChatHistoryEntry[]>("pull_history")
      .then((remote) => {
        setChatHistory((local) => {
          const byId = new Map(local.map((e) => [e.id, e]));
          for (const r of remote) {
            const mine = byId.get(r.id);
            if (!mine || r.updatedAt > mine.updatedAt) byId.set(r.id, r);
          }
          const merged = [...byId.values()]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_HISTORY_ENTRIES);
          saveChatHistory(merged, userIdRef.current);
          return merged;
        });
      })
      .catch((e) => console.warn("History pull failed:", e));
  }, [syncsHistory, userId]);

  /*
   * Pro+: custom models for the model picker, kept in sync with Settings.
   */
  const customModelsUnlocked = canUse(effectiveTier, "customModels");
  useEffect(() => {
    if (!customModelsUnlocked || !userId) {
      setCustomModels([]);
      return;
    }
    const load = () =>
      invoke<CustomModel[]>("list_custom_models")
        .then(setCustomModels)
        .catch(() => setCustomModels([]));
    void load();
    const un = listen("models-updated", () => void load());
    return () => {
      void un.then((fn) => fn());
    };
  }, [customModelsUnlocked, userId]);

  // Agent Mode is rolled out gradually; ask the server whether it's on for us.
  useEffect(() => {
    if (!canUse(effectiveTier, "agentMode") || !userId) {
      setAgentAllowed(null);
      return;
    }
    invoke<boolean>("agent_access")
      .then(setAgentAllowed)
      .catch(() => setAgentAllowed(false));
  }, [effectiveTier, userId]);

  // If a previous run was interrupted (crash, reload), never start with an invisible chat.
  useEffect(() => {
    void invoke("agent_restore", { show: false });
  }, []);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  // Look for a new version shortly after launch and every few hours.
  useEffect(() => {
    let stop = false;
    const look = async () => {
      try {
        const update = await checkForUpdate();
        if (!stop && update) {
          updateRef.current = update;
          setUpdateInfo({ version: update.version });
        }
      } catch {
        /* no feed yet, offline, or no update: nothing to show */
      }
    };
    const first = window.setTimeout(look, 30_000);
    const every = window.setInterval(look, 6 * 3600_000);
    return () => {
      stop = true;
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, []);

  async function installUpdate() {
    if (!updateRef.current || updating) return;
    setUpdating(true);
    try {
      await updateRef.current.downloadAndInstall();
      await invoke("restart_app");
    } catch {
      setUpdating(false);
      setBlockedNotice("The update didn't install. Please try again, or download it from clickrai.com.");
      window.setTimeout(() => setBlockedNotice(null), 6000);
    }
  }

  // A different account (or signing out) must never see the previous one's conversation.
  useEffect(() => {
    const previous = userIdRef.current;
    userIdRef.current = userId;
    try {
      localStorage.removeItem(HISTORY_STORAGE_KEY); // the old shared, un-keyed history
    } catch {
      /* ignore */
    }
    if (previous !== userId) {
      setMessages([]);
      sessionIdRef.current = crypto.randomUUID();
    }
    setChatHistory(loadChatHistory(userId));
  }, [userId]);

  // If the app itself breaks (an uncaught error), offer the bug report window instead of
  // leaving the user guessing. Throttled and filtered so harmless noise never nags.
  useEffect(() => {
    let last = 0;
    const NOISE = /ResizeObserver|unregisterListener|handlerId|listeners\[eventId\]|Script error|not_signed_in|AbortError|Load failed/i;
    const flag = (reason: unknown) => {
      const text = String(reason instanceof Error ? reason.message : reason ?? "");
      if (!text || NOISE.test(text) || Date.now() - last < 60_000) return;
      last = Date.now();
      setCrashNotice(text.slice(0, 1500));
    };
    const onError = (e: ErrorEvent) => flag(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => flag(e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Remember where you drag the pill, and put it back there next launch (only if that spot is
  // still on a connected screen).
  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    let timer = 0;

    (async () => {
      try {
        const saved = JSON.parse(localStorage.getItem("clickr-pill-pos") ?? "null") as { x: number; y: number } | null;
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          const monitors = await availableMonitors();
          const visible = monitors.some(
            (m) =>
              saved.x >= m.position.x - 20 &&
              saved.x <= m.position.x + m.size.width - 120 &&
              saved.y >= m.position.y - 10 &&
              saved.y <= m.position.y + m.size.height - 80,
          );
          if (visible && !cancelled) await win.setPosition(new PhysicalPosition(saved.x, saved.y));
        }
      } catch {
        /* keep the default spot */
      }
    })();

    const un = win.onMoved(({ payload }) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          localStorage.setItem("clickr-pill-pos", JSON.stringify({ x: payload.x, y: payload.y }));
        } catch {
          /* ignore */
        }
      }, 400);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void un.then((fn) => fn());
    };
  }, []);

  // Put the cursor in the message box whenever the chat appears or a reply finishes, so you can
  // just start typing.
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = pricingModalOpen || agentBetaOpen || tourActive || agentRunning;
  useEffect(() => {
    const focusInput = () => {
      if (overlayOpenRef.current) return;
      window.setTimeout(() => textareaRef.current?.focus(), 60);
    };
    const un = listen("panel-shown", focusInput);
    window.addEventListener("focus", focusInput);
    return () => {
      window.removeEventListener("focus", focusInput);
      void un.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    if (status === "idle" && !overlayOpenRef.current) textareaRef.current?.focus();
  }, [status]);

  // Esc hides the chat (unless something on top of it should take Esc first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (overlayOpenRef.current || historyOpen || modelMenuOpen || busy) return;
      void invoke("hide_panel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen, modelMenuOpen, busy]);

  // While the Accessibility step is open, notice the moment the permission is granted and carry on.
  useEffect(() => {
    if (!agentBetaOpen || !agentAccessStep) return;
    const timer = window.setInterval(() => {
      invoke<boolean>("check_accessibility")
        .then((ok) => {
          if (!ok) return;
          window.clearInterval(timer);
          setAxGranted(true);
          window.setTimeout(() => {
            setAgentBetaOpen(false);
            setAgentAccessStep(false);
            setAgentMode(true);
          }, 900);
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [agentBetaOpen, agentAccessStep]);

  // Esc closes the Agent Mode beta notice without turning the mode on.
  useEffect(() => {
    if (!agentBetaOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeAgentBeta();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentBetaOpen]);

  // The status pill (separate window) sends Allow / Skip / Stop back to us.
  const agentHandlersRef = useRef({ resolve: (_d: ApprovalDecision) => {}, stop: () => {} });
  agentHandlersRef.current = { resolve: resolveApproval, stop: stopAgent };
  useEffect(() => {
    const unlisteners = [
      listen<{ decision: ApprovalDecision }>("agent-decision", (e) => {
        if (e.payload.decision === "stop") agentHandlersRef.current.stop();
        else agentHandlersRef.current.resolve(e.payload.decision);
      }),
    ];
    return () => {
      unlisteners.forEach((u) => void u.then((fn) => fn()));
    };
  }, []);

  // Drop Pro+ modes if the plan changes underneath us.
  useEffect(() => {
    if (!canUse(effectiveTier, "agentMode")) {
      setAgentMode(false);
      setReasoningOn(false);
    }
  }, [effectiveTier]);

  // Close the model dropdown on outside click.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelMenuOpen]);

  /*
   * Restore shortcuts. Custom hotkeys are a Pro feature; other tiers always
   * get the defaults (the saved choice is kept for if they upgrade).
   */
  const hotkeysUnlocked = canUse(effectiveTier, "customHotkeys");
  useEffect(() => {
    void invoke("set_global_shortcuts", {
      toggleShortcut: hotkeysUnlocked ? shortcut : DEFAULT_TOGGLE_SHORTCUT,
      assistShortcut: hotkeysUnlocked ? assistShortcut : DEFAULT_ASSIST_SHORTCUT,
      fallbackToggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
      fallbackAssistShortcut: DEFAULT_ASSIST_SHORTCUT,
    }).catch((error) => {
      console.error("Failed to register global shortcuts:", error);
    });
  }, [shortcut, assistShortcut, hotkeysUnlocked]);

  /*
   * Receive settings changes from the
   * separate native settings window.
   */
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    void listen("settings-updated", (event) => {
      const payload = event.payload as {
        forceScreenshot?: boolean;
        replayOnboarding?: boolean;
      };

      if (typeof payload.forceScreenshot === "boolean") {
        setForceScreenshot(payload.forceScreenshot);
      }

      if (payload.replayOnboarding) {
        setTourStep(0);
        setSpotlight(null);
        setTourCardPosition(null);
        setTourActive(true);
      }
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      cleanup?.();
    };
  }, []);

  /*
   * Persist the current conversation to
   * chat history whenever it changes.
   */
  useEffect(() => {
    if (messages.length === 0) return;
    if (!canUse(effectiveTier, "history")) return;

    const firstUserMessage = messages.find((m) => m.role === "user");
    const lastMessage = messages[messages.length - 1];

    const entry: ChatHistoryEntry = {
      id: sessionIdRef.current,
      title: firstUserMessage ? titleFromMessage(firstUserMessage.text) : "New chat",
      preview: lastMessage.text.slice(0, 60),
      updatedAt: Date.now(),
      messages,
    };

    setChatHistory((prev) => {
      const withoutCurrent = prev.filter((e) => e.id !== entry.id);
      const next = [entry, ...withoutCurrent];
      saveChatHistory(next, userIdRef.current);
      return next;
    });

    if (canUse(effectiveTier, "historySync")) {
      // Strip attached images — they're big and stay on the device.
      const slim = { ...entry, messages: entry.messages.map((m) => ({ ...m, imageDataUrl: undefined, attachments: undefined })) };
      const timer = window.setTimeout(() => {
        invoke("push_history", { entries: [slim] }).catch((e) => console.warn("History push failed:", e));
      }, 1500);
      return () => window.clearTimeout(timer);
    }
  }, [messages]);

  /*
   * Close the history popover when clicking outside it.
   */
  useEffect(() => {
    if (!historyOpen) return;

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;

      if (
        historyPopoverRef.current &&
        !historyPopoverRef.current.contains(target) &&
        !target.closest('[data-history-trigger="true"]')
      ) {
        setHistoryOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [historyOpen]);

  /*
   * Background the model gets with every question. Free: device context and
   * recent turns. Pro adds the active app, saved memories and a longer window.
   */
  const memoryCacheRef = useRef<{ at: number; data: Memory[] } | null>(null);

  async function loadMemoriesCached(): Promise<Memory[]> {
    const cached = memoryCacheRef.current;
    if (cached && Date.now() - cached.at < 60_000) return cached.data;
    const data = await invoke<Memory[]>("list_memories").catch(() => [] as Memory[]);
    memoryCacheRef.current = { at: Date.now(), data };
    return data;
  }

  /**
   * Calls the AI and shows the answer as it arrives. The assistant message is
   * created on the first piece of text and finalised when the reply completes;
   * callers must not add the answer themselves.
   */
  async function askWithStream(args: Record<string, unknown>): Promise<string> {
    const streamId = crypto.randomUUID();
    let pending = "";
    let frame = 0;

    const flush = () => {
      frame = 0;
      if (!pending) return;
      const chunk = pending;
      pending = "";
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.streamId === streamId);
        if (i === -1) return [...prev, { role: "assistant", text: chunk, streamId, streaming: true }];
        const next = prev.slice();
        next[i] = { ...next[i], text: next[i].text + chunk };
        return next;
      });
    };

    const unlisten = await listen<{ id: string; text: string }>("ask-delta", (event) => {
      if (event.payload.id !== streamId) return;
      pending += event.payload.text;
      if (!frame) frame = requestAnimationFrame(flush);
    });

    const settle = (finalText?: string) => {
      if (frame) cancelAnimationFrame(frame);
      pending = "";
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.streamId === streamId);
        if (i === -1) {
          return finalText ? [...prev, { role: "assistant", text: finalText }] : prev;
        }
        const next = prev.slice();
        next[i] = { ...next[i], text: finalText ?? next[i].text, streaming: false, streamId: undefined };
        return next;
      });
    };

    // "Stop" ends the wait immediately; whatever already arrived stays on screen.
    const cancelled = new Promise<never>((_, reject) => {
      askCancelRef.current = () => reject({ kind: "cancelled" });
    });

    try {
      const answer = await Promise.race([invoke<string>("ask_ai", { ...args, streamId }), cancelled]);
      settle(answer);
      return answer;
    } catch (error) {
      settle();
      throw error;
    } finally {
      askCancelRef.current = null;
      unlisten();
    }
  }

  async function buildContext(withConversation = true): Promise<string> {
    const lines: string[] = [];
    const now = new Date();
    lines.push(
      `Current time: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}), platform: ${navigator.platform}, locale: ${navigator.language}`,
    );

    // Independent lookups run side by side instead of one after another.
    const [app, memories] = await Promise.all([
      canUse(effectiveTier, "appAware")
        ? invoke<string | null>("get_active_app").catch(() => null)
        : Promise.resolve(null),
      canUse(effectiveTier, "memory") ? loadMemoriesCached() : Promise.resolve([] as Memory[]),
    ]);

    if (app) lines.push(`Frontmost app/window: ${app}`);

    if (memories.length > 0) {
      lines.push("Things the user asked you to remember:");
      memories.slice(-30).forEach((m) => lines.push(`- ${m.content}`));
    }

    const turns = canUse(effectiveTier, "memory") ? 12 : 4;
    const recent = withConversation ? messages.filter((m) => !m.isError && !m.kind).slice(-turns) : [];
    if (recent.length > 0) {
      lines.push("Recent conversation (oldest first):");
      recent.forEach((m) => lines.push(`${m.role === "user" ? "User" : "Clickr"}: ${clip(m.text, 600)}`));
    }

    return `[Clickr background context — use only if relevant, do not mention it]\n${lines.join("\n")}`;
  }


  const activeCustomModel =
    canUse(effectiveTier, "customModels") && customModels.some((m) => m.id === selectedModel)
      ? selectedModel
      : undefined;
  const reasoningActive = reasoningOn && canUse(effectiveTier, "reasoning") && !activeCustomModel;
  const activeModelName = activeCustomModel
    ? customModels.find((m) => m.id === activeCustomModel)!.name
    : "Clickr AI";

  /*
   * Free users get the "Limit resets in … / Upgrade now" popup above the chat
   * box. Paid plans don't see an upsell; they just get a plain notice.
   */
  function limitReply(ms: number): Message {
    const wait = formatReset(ms);
    return effectiveTier === "free"
      ? {
          role: "assistant",
          text: `You've reached your free limit. Please wait **${wait}** for it to reset, or upgrade to continue the conversation now.`,
          upgradeCta: true,
        }
      : {
          role: "assistant",
          text: `You've reached your usage limit for now. It resets in **${wait}**.`,
        };
  }

  function onLimitReached(retryAfterSeconds?: number) {
    const seconds = retryAfterSeconds ?? 3600;
    setLimitReachedUntil(Date.now() + seconds * 1000);
    setBannerDismissed(false);
    // The message the user just sent gets an automated answer instead of silence.
    setMessages((prev) => [...prev, limitReply(seconds * 1000)]);
  }

  function handleAskError(error: unknown) {
    const askErr = error as { kind?: string; message?: string; retry_after_seconds?: number } | string;
    const e = typeof askErr === "string" ? { message: askErr } : askErr;

    if (e.kind === "not_signed_in" || e.kind === "cancelled") return;

    if (e.kind === "limit_reached") {
      onLimitReached(e.retry_after_seconds);
      return;
    }

    if (e.message === "agent_not_available") {
      setAgentAllowed(false);
      setAgentMode(false);
      setBlockedNotice("Agent Mode is rolling out gradually and isn't on for your account yet.");
      window.setTimeout(() => setBlockedNotice(null), 4000);
      return;
    }

    if (e.kind === "plan_required" || e.message === "plan_required") {
      promptUpgrade(activeCustomModel ? "customModels" : reasoningActive ? "reasoning" : "agentMode");
      return;
    }

    setAiHealth("error");
    setMessages((prev) => [
      ...prev,
      { role: "assistant", text: e.message ?? "Something went wrong. Please try again.", isError: true },
    ]);
  }

  /* ---------------------------------------------------------
     AGENT MODE (Pro+)
     --------------------------------------------------------- */

  function askApproval(call: AgentCall): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      approvalResolverRef.current = resolve;
      const text = describeCall(call, elementIndexRef.current);
      setPendingApproval({ call, text });
      void emit("agent-approval", { text }); // shown on the status pill while the chat is hidden
    });
  }

  function resolveApproval(decision: ApprovalDecision) {
    approvalResolverRef.current?.(decision);
    approvalResolverRef.current = null;
    setPendingApproval(null);
    void emit("agent-approval", null);
  }

  /** Turns Agent Mode on, first making sure macOS Accessibility access is in place. */
  async function turnOnAgent() {
    const ok = await invoke<boolean>("check_accessibility").catch(() => false);
    if (ok) {
      setAgentBetaOpen(false);
      setAgentAccessStep(false);
      setAgentMode(true);
      return;
    }
    setAxGranted(false);
    setAgentAccessStep(true);
    setAgentBetaOpen(true);
  }

  function closeAgentBeta() {
    setAgentBetaOpen(false);
    setAgentAccessStep(false);
  }

  async function ensureNotificationPermission() {
    try {
      if (!(await isPermissionGranted())) await requestPermission();
    } catch {
      /* notifications are optional */
    }
  }

  async function notify(title: string, body: string) {
    try {
      if (await isPermissionGranted()) sendNotification({ title, body });
    } catch {
      /* optional */
    }
  }

  /** Re-sends your last message after a failed answer (without stacking a duplicate). */
  function retryLast() {
    if (busy || agentRunning) return;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && !messages[i].kind) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    const last = messages[idx];
    setMessages((prev) => prev.slice(0, idx));
    void handleSend({ text: last.text, attachments: last.attachments });
  }

  function recallLastMessage(): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && !messages[i].kind) return messages[i].text;
    }
    return null;
  }

  function stopAnswer() {
    askCancelRef.current?.();
  }

  function stopAgent() {
    // Not an agent run: this is the "Back to Clickr" button (or the hotkey) while waiting for a purchase.
    if (!agentRunning && uiHidden) {
      void restoreAfterPurchase();
      return;
    }
    agentCancelRef.current = true;
    if (approvalResolverRef.current) resolveApproval("stop");
  }

  async function runAgent(goal: string) {
    if (!canUse(effectiveTier, "agentMode")) {
      promptUpgrade("agentMode");
      return;
    }

    agentCancelRef.current = false;
    setAgentRunning(true);
    // Get the chat out of the way: it goes invisible and click-through, and a
    // small status pill takes its place until the run ends.
    await invoke("set_agent_hidden", { hidden: true }).catch(() => {});
    await invoke("agent_bar_show").catch(() => {});
    void emit("agent-status", { text: "Getting started…" });
    void invoke("agent_cursor_show");
    setStatus("thinking");

    let autoApprove = canUse(effectiveTier, "beta") && localStorage.getItem("clickr-auto-approve") === "true";
    const history: Array<Record<string, unknown>> = [];
    const startedAt = Date.now();
    let outcome = "";
    const say = (text: string, isError = false) => {
      outcome = text;
      setMessages((prev) => [...prev, { role: "assistant", text, isError }]);
    };

    try {
      const context = await buildContext();
      let shot: string | undefined = await invoke<string>("capture_screenshot", { allDisplays: false, maxDimension: 2000 });
      const pendingCalls: Array<{ call: AgentCall; signature?: string; result: string }> = [];
      const recentActions: string[] = [];

      // There is no step limit. Instead the run is stopped by fail-safes the moment it looks broken:
      // repeating or cycling actions, a run of failures, or a screen that stops changing.
      let failStreak = 0;
      let stuckScreens = 0;
      let lastShotHash = "";
      let actedSinceShot = false;

      for (let i = 0; ; i++) {
        if (agentCancelRef.current) {
          say("Stopped.");
          return;
        }

        const step = await invoke<
          | { type: "final"; answer: string }
          | {
              type: "calls";
              note?: string;
              calls: Array<{ name: string; args: Record<string, unknown>; signature?: string }>;
            }
        >("agent_step", {
          goal,
          context,
          history,
          screenshotBase64: shot,
          reasoning: reasoningActive,
        });
        shot = undefined;

        if (step.type === "final") {
          say(step.answer);
          return;
        }

        // What the agent says it sees, shown live so you can follow along.
        if (step.note) {
          void emit("agent-status", { text: step.note });
          setMessages((prev) => [...prev, { role: "assistant", text: step.note!, kind: "step", stepId: `note-${Date.now()}-${i}`, stepStatus: "done", isNote: true }]);
        }

        // The model may batch a few predictable actions (click, type, press return).
        // Every call must get a result back, so skipped ones are reported too.
        const background = localStorage.getItem("clickr-agent-background-input") === "true";
        let needsLook = false;
        let halted: string | null = null;

        for (let c = 0; c < step.calls.length; c++) {
          if (agentCancelRef.current) {
            say("Stopped.");
            return;
          }
          const raw = step.calls[c];
          const call: AgentCall = { name: raw.name, args: raw.args ?? {} };
          // Calls and results must be grouped (all calls, then all results) for the model.
          // So collect, then flush in order after the loop.
          if (halted) {
            pendingCalls.push({ call, signature: raw.signature, result: halted });
            continue;
          }

          if (usesComputerControl(call) && !(await invoke<boolean>("check_accessibility"))) {
            void invoke("open_system_settings_pane", { pane: "accessibility" });
            say(
              "Computer control needs the **Accessibility** permission. I opened System Settings — enable Clickr there, restart Clickr, and run this again.",
              true,
            );
            return;
          }

          if (needsApproval(call) && !autoApprove) {
            const decision = await askApproval(call);
            if (decision === "stop" || agentCancelRef.current) {
              say("Stopped.");
              return;
            }
            if (decision === "deny") {
              halted = "The user denied this action and the rest of this batch was skipped. Do not retry it; ask what to do instead or finish.";
              pendingCalls.push({ call, signature: raw.signature, result: halted });
              continue;
            }
            if (decision === "approve_all") autoApprove = true;
          }

          const stepId = `${Date.now()}-${i}-${c}`;
          const label = describeCall(call, elementIndexRef.current);
          void emit("agent-status", { text: label });
          setMessages((prev) => [
            ...prev,
            { role: "assistant", text: label, kind: "step", stepId, stepStatus: "running" },
          ]);

          let result: string;
          let ok = true;
          try {
            result = await invoke<string>("agent_exec", { name: call.name, args: call.args, background });
            if (call.name === "list_ui_elements") elementIndexRef.current = parseElementList(result);
          } catch (e) {
            ok = false;
            result = `Error: ${String(e)}`;
          }

          setMessages((prev) =>
            prev.map((m) => (m.stepId === stepId ? { ...m, stepStatus: ok ? "done" : "error" } : m)),
          );

          // Fail-safe 1: the same action again and again means it is stuck.
          const sig = `${call.name}:${JSON.stringify(call.args)}`;
          recentActions.push(sig);
          const repeats = recentActions.slice(-8).filter((x) => x === sig).length;
          if (repeats >= 6) {
            say("I kept repeating the same action without making progress, so I stopped to avoid doing damage. Tell me how you'd like me to continue.", true);
            return;
          }
          // Fail-safe 2: going round in circles (A,B,A,B… or A,B,C,A,B,C…).
          if (isCycle(recentActions)) {
            say("I was going round in circles, so I stopped. Tell me how you'd like me to continue.", true);
            return;
          }
          // Fail-safe 3: a run of failures or refusals in a row.
          failStreak = !ok || /^(Error|Refused|Nothing was typed)/.test(result) ? failStreak + 1 : 0;
          if (failStreak >= 5) {
            say("Five actions in a row failed, so I stopped instead of trying again and again. Tell me what to do next, or try once more.", true);
            return;
          }
          if (["click", "type_text", "press_key", "press_element", "scroll", "open_url", "open_app"].includes(call.name)) {
            actedSinceShot = true;
          }
          if (repeats >= 3) {
            result += `\n[Warning: you have done this exact action ${repeats} times without progress. Do something different or stop and explain.]`;
          }

          pendingCalls.push({ call, signature: raw.signature, result });
          if (!ok) halted = "Skipped because the previous action in this batch failed.";
          else if (endsBatch(call, call.name === "press_element" ? elementIndexRef.current.get(Number(call.args.id)) : undefined)) {
            halted = "Skipped on purpose: the previous action probably changed the page (submit / next / navigation). Look at the new screen before doing anything else.";
          }
          if (await invoke<boolean>("agent_tool_needs_screen", { name: call.name })) needsLook = true;
        }

        for (const p of pendingCalls) {
          history.push({ kind: "call", name: p.call.name, args: p.call.args, signature: p.signature });
        }
        for (const p of pendingCalls) {
          history.push({ kind: "result", name: p.call.name, result: p.result });
        }
        pendingCalls.length = 0;

        if (needsLook) {
          shot = await invoke<string>("capture_screenshot", { allDisplays: false, maxDimension: 2000 });

          // Fail-safe 4: actions were taken but the screen is not changing.
          const hash = hashShot(shot);
          if (actedSinceShot && hash === lastShotHash) stuckScreens += 1;
          else stuckScreens = 0;
          lastShotHash = hash;
          actedSinceShot = false;
          if (stuckScreens >= 4) {
            say("The screen stopped changing after my last few actions, so I stopped. Tell me how you'd like me to continue.", true);
            return;
          }
          if (stuckScreens >= 2) {
            // Tell the model, so it can change approach before the run is stopped.
            const last = history[history.length - 1] as { result?: string } | undefined;
            if (last && typeof last.result === "string") {
              last.result += "\n[Note: the screen did not change after your last actions. Try a different approach or stop and explain.]";
            }
          }
        }
      }
    } catch (error) {
      handleAskError(error);
    } finally {
      // Runs longer than a few seconds: you were probably in another app, so say when it's done.
      if (Date.now() - startedAt > 8000) {
        const stopped = /^Stopped/.test(outcome);
        void notify(
          stopped ? "Clickr stopped" : "Clickr finished",
          outcome.replace(/[*_`#]/g, "").slice(0, 140) || "Open Clickr to see what happened.",
        );
      }

      // One atomic restore: chat back and clickable, status pill + cursor overlay gone.
      setAgentRunning(false);
      setStatus("idle");
      setPendingApproval(null);
      approvalResolverRef.current = null;
      void emit("agent-approval", null);
      setPanelVisible(true);
      void invoke("agent_restore");
      window.setTimeout(() => void updateClickableRectRef.current(), 250);
    }
  }

  /*
   * Assist ALWAYS uses a screenshot.
   */
  async function handleAssist() {
   if (isLimited) {
     setBannerDismissed(false);
     setMessages((prev) => [...prev, { role: "user", text: "Help me with this" }, limitReply(remainingMs)]);
     return;
    }

    if (busy || tourActive) return;

    setMessages((prev) => [...prev, { role: "user", text: "Help me with this" }]);
    setStatus("looking");

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    try {
      // Capture the screen and gather context at the same time.
      const [screenshot, context] = await Promise.all([
        invoke<string>("capture_screenshot", { allDisplays: canUse(effectiveTier, "multiMonitor") }),
        buildContext(),
      ]);
      setStatus("thinking");

      await askWithStream({
        question: "Help me with this.",
        screenshotBase64: screenshot,
        context,
        webSearch: false,
        customModelId: activeCustomModel,
        reasoning: reasoningActive,
      });

      setAiHealth("healthy");
    } catch (error) {
      const askErr = error as { kind?: string; message?: string; retry_after_seconds?: number };

      if (askErr.kind === "not_signed_in" || askErr.kind === "cancelled") {
      } else if (askErr.kind === "limit_reached") {
        onLimitReached(askErr.retry_after_seconds);
      } else {
        setAiHealth("error");
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: askErr.message ?? "Something went wrong. Please try again.", isError: true },
        ]);
      }
    } finally {
      setStatus("idle");
    }
  }

  assistHandlerRef.current = () => {
    void handleAssist();
  };

  /*
   * Global Assist event.
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void listen("assist-shortcut", () => {
      assistHandlerRef.current();
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  /*
   * Tour spotlight.
   */
  useEffect(() => {
    if (!tourActive) {
      setSpotlight(null);
      setTourCardPosition(null);
      return;
    }

    function updateSpotlight() {
      const step = TOUR_STEPS[tourStep];
      if (!step) return;

      const element = document.querySelector(
        `[data-tour="${step.target}"]`,
      ) as HTMLElement | null;

      if (!element) {
        setSpotlight(null);
        return;
      }

      const rect = element.getBoundingClientRect();

      setSpotlight({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      });
    }

    const timer = window.setTimeout(updateSpotlight, 40);

    window.addEventListener("resize", updateSpotlight);
    window.addEventListener("scroll", updateSpotlight);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", updateSpotlight);
      window.removeEventListener("scroll", updateSpotlight);
    };
  }, [tourActive, tourStep, panelVisible]);

  /*
   * Tour card positioning.
   */
  useEffect(() => {
    if (!tourActive || !spotlight) {
      setTourCardPosition(null);
      return;
    }

    const timer = window.setTimeout(() => {
      const card = tourCardRef.current;
      if (!card) return;

      const cardRect = card.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const gap = 14;
      const margin = 14;

      const targetLeft = spotlight.left;
      const targetTop = spotlight.top;
      const targetBottom = spotlight.top + spotlight.height;

      let top = 0;
      let left = 0;

      if (tourStep <= 2 && targetBottom + gap + cardRect.height <= viewportHeight - margin) {
        top = targetBottom + gap;
        left = targetLeft + spotlight.width / 2 - cardRect.width / 2;
      } else if (targetTop - gap - cardRect.height >= margin) {
        top = targetTop - gap - cardRect.height;
        left = targetLeft + spotlight.width / 2 - cardRect.width / 2;
      } else {
        top = targetBottom + gap;
        left = targetLeft + spotlight.width / 2 - cardRect.width / 2;
      }

      if (left + cardRect.width > viewportWidth - margin) {
        left = viewportWidth - cardRect.width - margin;
      }

      if (left < margin) left = margin;

      if (top + cardRect.height > viewportHeight - margin) {
        top = viewportHeight - cardRect.height - margin;
      }

      if (top < margin) top = margin;

      setTourCardPosition({ top, left });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [tourActive, tourStep, spotlight]);

  /*
   * Conversation scrolling.
   */
  const stickToBottomRef = useRef(true);
  const lastMessage = messages[messages.length - 1];
  const lastLength = lastMessage?.text.length ?? 0;

  useEffect(() => {
    if (!scrollRef.current) return;
    // A new message you sent always scrolls down; streamed text only follows if you're already at the bottom.
    if (!stickToBottomRef.current && lastMessage?.role !== "user") return;

    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: lastMessage?.streaming ? "auto" : messages.length > 1 ? "smooth" : "auto",
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, status, lastLength]);

  /*
   * Normal question.
   */
  async function handleSend(override?: { text: string; attachments?: Attachment[] }) {
    const typedInput = override?.text ?? input;
    const sendAttachments = override?.attachments ?? attachments;

    if (isLimited) {
      const typed = typedInput.trim();
      if (!typed || tourActive) return;
      setBannerDismissed(false);
      setInput("");
      setMessages((prev) => [...prev, { role: "user", text: typed }, limitReply(remainingMs)]);
      return;
    }
    if (!typedInput.trim() || busy || tourActive) return;

    const question = typedInput.trim();

    // "Remember …" saves a memory (Pro). Free users get an upgrade nudge but
    // the message still goes to the AI as normal.
    const rememberMatch = question.match(/^remember(?: that)?[:,]?\s+(.{3,})$/i);
    if (rememberMatch) {
      if (canUse(effectiveTier, "memory")) {
        try {
          await invoke("add_memory", { content: rememberMatch[1] });
          memoryCacheRef.current = null;
          setMessages((prev) => [
            ...prev,
            { role: "user", text: question },
            { role: "assistant", text: "Got it — I'll remember that." },
          ]);
          setInput("");
          return;
        } catch (error) {
          console.warn("Couldn't save memory:", error);
        }
      } else {
        promptUpgrade("memory");
      }
    }

    setMessages((prev) => [
      ...prev,
      { role: "user", text: question, attachments: sendAttachments.length ? sendAttachments : undefined },
    ]);

    setInput("");

    if (agentMode && canUse(effectiveTier, "agentMode")) {
      setAttachments([]);
      await runAgent(question);
      return;
    }

    const needsScreenshot = forceScreenshot || (sendAttachments.length === 0 && questionNeedsScreenshot(question));
    setStatus(needsScreenshot ? "looking" : "thinking");

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    try {
      // Capture the screen (if needed) and gather context at the same time.
      const [screenshot, context] = await Promise.all([
        needsScreenshot
          ? invoke<string>("capture_screenshot", { allDisplays: canUse(effectiveTier, "multiMonitor") })
          : Promise.resolve(undefined),
        buildContext(),
      ]);
      setStatus("thinking");

      await askWithStream({
        question,
        screenshotBase64: screenshot,
        attachedImagesBase64: sendAttachments.length ? sendAttachments.map((a) => a.dataUrl) : undefined,
        context,
        webSearch: questionNeedsWeb(question),
        customModelId: activeCustomModel,
        reasoning: reasoningActive,
      });

      setAiHealth("healthy");
    } catch (error) {
      handleAskError(error);
    } finally {
      setStatus("idle");
      setAttachments([]);
    }
  }

  /*
   * Main native window drag.
   */
  function handleDrag(e: React.MouseEvent) {
    if (tourActive) return;

    const target = e.target as HTMLElement;
    if (target.closest("button, input, textarea, select")) return;

    void getCurrentWindow().startDragging();
  }

  // Hide/Show only collapses the chat panel. The pill must stay focused and
  // clickable, so we do NOT make the window click-through here — the global
  // mouse monitor already does that once the cursor leaves the pill.
  function togglePanel() {
    if (tourActive) return;
    setPanelVisible((visible) => !visible);
  }

  // Shrink the clickable area to the new layout once it has rendered.
  useEffect(() => {
    const id = requestAnimationFrame(() => void updateClickableRectRef.current());
    return () => cancelAnimationFrame(id);
  }, [panelVisible]);

  function handleAttachClick() {
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setUploadProgress(30);
    let added = 0;
    for (const file of files) {
      if (!canAttachFile(effectiveTier, file.name)) {
        promptUpgrade("advancedFiles");
        break;
      }
      try {
        const dataUrl = await readDataUrl(file);
        if (!addAttachment({ dataUrl, name: file.type.startsWith("image/") ? undefined : file.name }, added)) break;
        added += 1;
      } catch {
        /* skip a file that can't be read */
      }
    }
    setUploadProgress(100);
    window.setTimeout(() => setUploadProgress(null), 300);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  async function openSettings() {
    if (tourActive) return;

    try {
      await invoke("open_settings");
    } catch (error) {
      console.error("Failed to open settings:", error);
    }
  }

  async function closeWindow() {
    try {
      await invoke("quit_app");
    } catch (error) {
      console.error("Failed to quit Clickr:", error);
    }
  }

  function setQuickPrompt(prompt: string) {
    if (tourActive) return;

    setInput(prompt);

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  function openHistoryChat(entry: ChatHistoryEntry) {
    sessionIdRef.current = entry.id;
    setMessages(entry.messages);
    setHistoryOpen(false);
  }

  /** Starts a fresh conversation (the old one stays in history on Pro). */
  function startNewChat() {
    if (busy || agentRunning) return;
    setMessages([]);
    sessionIdRef.current = crypto.randomUUID();
    setInput("");
    setAttachments([]);
    setHistoryOpen(false);
    stickToBottomRef.current = true;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function deleteChat(id: string) {
    setChatHistory((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveChatHistory(next, userIdRef.current);
      return next;
    });
    if (canUse(effectiveTier, "historySync")) void invoke("delete_synced_chat", { id }).catch(() => {});
    // Deleting the chat you're in leaves you in a fresh one, so it can't quietly reappear.
    if (id === sessionIdRef.current) {
      setMessages([]);
      sessionIdRef.current = crypto.randomUUID();
    }
  }

  function clearChatHistory() {
    setChatHistory([]);
    saveChatHistory([], userIdRef.current);
    if (canUse(effectiveTier, "historySync")) void invoke("clear_synced_history").catch(() => {});
  }

  function finishTour() {
    if (userId) localStorage.setItem(onboardingKey(userId), "true");
    setTourActive(false);
    setTourStep(0);
    setSpotlight(null);
    setTourCardPosition(null);
  }

  function nextTourStep() {
    if (tourStep >= TOUR_STEPS.length - 1) {
      finishTour();
      return;
    }

    setTourStep((step) => step + 1);
  }

  function skipTour() {
    finishTour();
  }

  return (
    <main className={`clickr-root ${tourActive ? "touring" : ""} ${agentRunning || uiHidden ? "agent-running" : ""}`}>
      <header 
        className={`cue-toolbar`}
        onMouseDown={handleDrag}>
        <div className="toolbar-drag" data-tour="drag">
          <span className="drag-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="drag-label">Drag</span>
        </div>

        <button className="toolbar-logo" type="button" title="Clickr">
          <img src={clickrLogoTransparent} alt="Clickr" className="clickr-logo-img" />
        </button>

        <div className="toolbar-divider" />

        <button
          className="toolbar-hide"
          data-tour="hide"
          type="button"
          {...makeSafeClickHandlers(clickDownPosRef, togglePanel)}
          title={panelVisible ? "Hide Clickr" : "Show Clickr"}
        >
          <span className={`hide-chevron ${panelVisible ? "hide-state" : "show-state"}`}>
            <Icon name="chevron" size={15} />
          </span>
          <span>{panelVisible ? "Hide" : "Show"}</span>
        </button>

        <div className="toolbar-divider" />

        <button
          className={`toolbar-listen ${status === "looking" ? "active" : ""}`}
          data-tour="awareness"
          type="button"
          title={status === "looking" ? "Screen Awareness — Active" : "Screen Awareness"}
          aria-label="Screen Awareness"
        >
          <span />
        </button>

        <div className="toolbar-divider" />

        <button
          className="toolbar-quit"
          type="button"
          {...makeSafeClickHandlers(clickDownPosRef, closeWindow)}
          title="Close Clickr"
          aria-label="Close Clickr"
        >
          <Icon name="x" size={14} />
        </button>
      </header>
    

      {panelVisible && (
        <section className={`cue-panel`}>
          <div className="panel-columns">
            <div className="panel-main">
              <div className="model-row">
                <span className={`live-dot ai-health-${aiHealth}`} />
                <div className="model-picker" ref={modelMenuRef}>
                  <button
                    type="button"
                    className={`model-trigger ${customModelsUnlocked ? "interactive" : ""} ${modelMenuOpen ? "open" : ""}`}
                    disabled={!customModelsUnlocked}
                    {...makeSafeClickHandlers(clickDownPosRef, () => setModelMenuOpen((o) => !o))}
                  >
                    <span className="model-name">{activeModelName}</span>
                    {customModelsUnlocked && (
                      <span className="model-chevron">
                        <Icon name="chevron" size={11} />
                      </span>
                    )}
                  </button>

                  {modelMenuOpen && customModelsUnlocked && (
                    <div className="model-menu">
                      {[{ id: "default", name: "Clickr AI", sub: "Default" }, ...customModels.map((m) => ({ id: m.id, name: m.name, sub: m.model_id }))].map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className={`model-menu-item ${(activeCustomModel ?? "default") === m.id ? "selected" : ""}`}
                          {...makeSafeClickHandlers(clickDownPosRef, () => {
                            setSelectedModel(m.id);
                            localStorage.setItem("clickr-selected-model", m.id);
                            setModelMenuOpen(false);
                          })}
                        >
                          <span className="model-menu-text">
                            <span className="model-menu-name">{m.name}</span>
                            <span className="model-menu-sub">{m.sub}</span>
                          </span>
                          {(activeCustomModel ?? "default") === m.id && <Icon name="check" size={13} />}
                        </button>
                      ))}
                      {customModels.length === 0 && (
                        <div className="model-menu-empty">Add your own models in Settings → AI.</div>
                      )}
                    </div>
                  )}
                </div>
                {hasMessages && !busy && (
                  <button
                    type="button"
                    className="new-chat-button"
                    title="New chat"
                    aria-label="New chat"
                    {...makeSafeClickHandlers(clickDownPosRef, startNewChat)}
                  >
                    <Icon name="plus" size={12} />
                    <span>New chat</span>
                  </button>
                )}
                <span className="model-status">
                  {agentRunning
                    ? "Agent working"
                    : status === "looking"
                    ? "Looking at screen"
                    : status === "thinking"
                      ? "Thinking"
                      : aiHealth === "error"
                        ? "AI unavailable"
                        : aiHealth === "healthy"
                          ? "Connected"
                          : "Checking…"}
                </span>
              </div>

              <div
                ref={scrollRef}
                className={`conversation ${hasMessages ? "has-messages" : ""}`}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
                }}
              >
                  <>

                    {!hasMessages && !busy && (
                      <div className="empty-state">
                        <div className="empty-icon">
                          <img src={clickrLogoFull} alt="Clickr" className="clickr-logo-img" />
                        </div>
                        <div className="empty-title">What can I help you with?</div>
                        <div className="empty-subtitle">
                          Ask about anything on your screen or conversation.
                        </div>
                      </div>
                    )}

                    {messages.map((message, index) => (
                      <div
                        key={index}
                        className={`message ${message.role === "user" ? "message-user" : "message-ai"}`}
                       >
                        {message.kind === "step" ? (
                          <div className={`agent-step ${message.stepStatus ?? ""} ${message.isNote ? "note" : ""}`}>
                            <span className="agent-step-icon">
                              {message.isNote ? (
                                <Icon name="sparkles" size={11} />
                              ) : message.stepStatus === "running" ? (
                                <span className="status-spinner" />
                              ) : message.stepStatus === "error" ? (
                                <Icon name="x" size={11} />
                              ) : (
                                <Icon name="check" size={11} />
                              )}
                            </span>
                            <span className="agent-step-text">{message.text}</span>
                          </div>
                        ) : message.role === "user" ? (
                          <div className="user-bubble">
                            {(message.attachments ??
                              (message.imageDataUrl || message.fileName
                                ? [{ dataUrl: message.imageDataUrl ?? "", name: message.fileName }]
                                : [])
                            ).map((att, i) =>
                              att.name ? (
                                <div key={i} className="attached-file-chip user-bubble-file-chip">
                                  <Icon name="paperclip" size={13} />
                                  <span>{att.name}</span>
                                </div>
                              ) : att.dataUrl ? (
                                <img key={i} src={att.dataUrl} alt="Attached reference" className="user-bubble-image" />
                              ) : null,
                            )}
                            {message.text}
                          </div>
                        ) : (
                          <div className={`ai-text ${message.isError ? "error" : ""} ${message.streaming ? "streaming" : ""}`}>
                            {message.isError ? (
                              <>
                                {message.text}
                                {index === messages.length - 1 && (
                                  <button
                                    type="button"
                                    className="retry-button"
                                    {...makeSafeClickHandlers(clickDownPosRef, retryLast)}
                                  >
                                    Try again
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="bug-link"
                                  {...makeSafeClickHandlers(clickDownPosRef, () => reportProblem("chat-error", message.text))}
                                >
                                  Report this problem
                                </button>
                              </>
                            ) : (
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkMath]}
                                rehypePlugins={[rehypeKatex]}
                                components={{
                                  code({ className, children, ...props }) {
                                    const match = /language-(\w+)/.exec(className || "");
                                    const code = String(children).replace(/\n$/, "");

                                    if (match) {
                                      return (
                                        <div className="markdown-code-wrapper">
                                          <SyntaxHighlighter
                                            language={match[1]}
                                            style={oneDark}
                                            PreTag="div"
                                            customStyle={{
                                              margin: 0,
                                              borderRadius: 12,
                                              fontSize: 13,
                                              background: "rgba(8, 10, 15, 0.9)",
                                            }}
                                          >
                                            {code}
                                          </SyntaxHighlighter>
                                          <button
                                            className="code-copy-button"
                                            type="button"
                                            onClick={() => navigator.clipboard.writeText(code)}
                                          >
                                            Copy
                                          </button>
                                        </div>
                                      );
                                    }

                                    return (
                                      <code className={className} {...props}>
                                        {children}
                                      </code>
                                    );
                                  },
                                  a({ children, ...props }) {
                                    return (
                                      <a {...props} target="_blank" rel="noreferrer">
                                        {children}
                                      </a>
                                    );
                                  },
                                }}
                              >
                                {message.text}
                              </ReactMarkdown>
                            )}
                            {message.upgradeCta && (
                              <button
                                type="button"
                                className="limit-upgrade-button inline-upgrade"
                                {...makeSafeClickHandlers(clickDownPosRef, () => promptUpgrade(null))}
                              >
                                Upgrade
                              </button>
                            )}
                            {!message.isError && !message.streaming && !message.upgradeCta && (
                              <div className="msg-actions">
                                <button
                                  type="button"
                                  className="msg-action"
                                  {...makeSafeClickHandlers(clickDownPosRef, () => {
                                    void navigator.clipboard.writeText(message.text).then(() => {
                                      setCopiedIndex(index);
                                      window.setTimeout(() => setCopiedIndex((i) => (i === index ? null : i)), 1400);
                                    });
                                  })}
                                >
                                  <Icon name={copiedIndex === index ? "check" : "copy"} size={11} />
                                  {copiedIndex === index ? "Copied" : "Copy"}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}

                    {status === "looking" && (
                      <div className="status-line">
                        <span className="status-spinner" />
                        Looking at your screen…
                      </div>
                    )}

                    {(status === "thinking" || messages.some((m) => m.streaming)) && !pendingApproval && (
                      <div className="status-line">
                        <span className="status-spinner" />
                        {agentRunning ? "Working…" : messages.some((m) => m.streaming) ? "Writing…" : "Thinking…"}
                        <button
                          type="button"
                          className="agent-stop"
                          {...makeSafeClickHandlers(clickDownPosRef, agentRunning ? stopAgent : stopAnswer)}
                        >
                          Stop
                        </button>
                      </div>
                    )}

                    {pendingApproval && (
                      <div className="approval-card">
                        <div className="approval-title">Clickr wants to:</div>
                        <div className="approval-action">{pendingApproval.text}</div>
                        <div className="approval-buttons">
                          <button type="button" className="approval-btn primary" {...makeSafeClickHandlers(clickDownPosRef, () => resolveApproval("approve"))}>
                            Allow
                          </button>
                          <button type="button" className="approval-btn" {...makeSafeClickHandlers(clickDownPosRef, () => resolveApproval("approve_all"))}>
                            Allow all this run
                          </button>
                          <button type="button" className="approval-btn" {...makeSafeClickHandlers(clickDownPosRef, () => resolveApproval("deny"))}>
                            Skip
                          </button>
                          <button type="button" className="approval-btn danger" {...makeSafeClickHandlers(clickDownPosRef, () => resolveApproval("stop"))}>
                            Stop
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                

              </div>
              

            {isLimited && !bannerDismissed && effectiveTier === "free" && (
              <div className="limit-banner">
                <div className="limit-banner-text">
                  <strong>Limit Reached.</strong>
                  <span>Try again in {formatDuration(remainingMs)}.</span>
                  <button
                    type="button"
                    className="limit-upgrade-button"
                    {...makeSafeClickHandlers(clickDownPosRef, () => promptUpgrade(null))}
                  >
                    Upgrade to chat more
                  </button>
                </div>
                <button
                  type="button"
                  className="limit-banner-close"
                  {...makeSafeClickHandlers(clickDownPosRef, () => setBannerDismissed(true))}
                  aria-label="Dismiss"
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            )}

            {updateInfo && (
              <div className="update-bar">
                <span className="update-bar-text">
                  {updating ? "Installing the update…" : `Clickr ${updateInfo.version} is ready`}
                </span>
                {!updating && (
                  <>
                    <button
                      type="button"
                      className="bug-toast-btn"
                      {...makeSafeClickHandlers(clickDownPosRef, () => void installUpdate())}
                    >
                      Update now
                    </button>
                    <button
                      type="button"
                      className="bug-toast-x"
                      aria-label="Later"
                      title="Later"
                      {...makeSafeClickHandlers(clickDownPosRef, () => setUpdateInfo(null))}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            )}

            {!online && (
              <div className="offline-bar">You&apos;re offline — Clickr needs an internet connection to answer.</div>
            )}

            {crashNotice && (
              <div className="bug-toast">
                <span className="bug-toast-text">Something went wrong in Clickr.</span>
                <button
                  type="button"
                  className="bug-toast-btn"
                  {...makeSafeClickHandlers(clickDownPosRef, () => {
                    reportProblem("crash", crashNotice);
                    setCrashNotice(null);
                  })}
                >
                  Report it
                </button>
                <button
                  type="button"
                  className="bug-toast-x"
                  aria-label="Dismiss"
                  {...makeSafeClickHandlers(clickDownPosRef, () => setCrashNotice(null))}
                >
                  ✕
                </button>
              </div>
            )}

            {blockedNotice && <div className="blocked-send-notice">{blockedNotice}</div>}

              
              <div className="action-row">
                <button
                  className="action-button primary"
                  type="button"
                  {...makeSafeClickHandlers(clickDownPosRef, () => setQuickPrompt("What should I say?"))}
                >
                  <span className="action-icon">
                    <Icon name="sparkles" size={13} />
                  </span>
                  <span>What should I say?</span>
                </button>

                <span className="action-separator">•</span>

                <button
                  className="action-button"
                  type="button"
                  {...makeSafeClickHandlers(clickDownPosRef, handleAssist)}
                  disabled={busy || tourActive}
                >
                  <span className="action-icon">
                    <Icon name="sparkles" size={13} />
                  </span>
                  <span>Assist</span>
                </button>
              </div>

              <div className={`composer ${busy ? "busy" : ""}`} data-tour="composer">
                <div className="input-area">
                  {!input && (
                    <div className="composer-placeholder">
                      Ask about your screen or conversation, or{" "}
                      <span className="keycap">⌘</span>
                      <span className="keycap">↵</span> for Assist
                    </div>
                  )}

                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onPaste={(e) => {
                      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                      if (files.length === 0) return; // plain text pastes as usual
                      e.preventDefault();
                      void (async () => {
                        let added = 0;
                        for (const file of files) {
                          const ok = addAttachment({ dataUrl: await readDataUrl(file) }, added);
                          if (!ok) break;
                          added += 1;
                        }
                      })();
                    }}
                    onKeyDown={(e) => {
                      // Up arrow in an empty box brings back your last message (to edit or resend).
                      if (e.key === "ArrowUp" && input === "") {
                        const last = recallLastMessage();
                        if (last) {
                          e.preventDefault();
                          setInput(last);
                        }
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    disabled={busy}
                    rows={1}
                    spellCheck={false}
                    aria-label="Ask Clickr"
                  />
                </div>

                {(attachments.length > 0 || uploadProgress !== null) && (
                  <div className="attached-image-preview attached-multi">
                    {attachments.map((att, i) => (
                      <div className="attached-item" key={i}>
                        {att.name ? (
                          <div className="attached-file-chip">
                            <Icon name="paperclip" size={14} />
                            <span>{att.name}</span>
                          </div>
                        ) : (
                          <img src={att.dataUrl} alt="Attached reference" />
                        )}
                        {uploadProgress === null && (
                          <button
                            type="button"
                            className="attached-image-remove"
                            onClick={() => removeAttachment(i)}
                            aria-label="Remove attachment"
                          >
                            <Icon name="x" size={11} />
                          </button>
                        )}
                      </div>
                    ))}

                    {uploadProgress !== null && (
                      <div className="upload-progress-track">
                        <div className="upload-progress-fill" style={{ width: `${uploadProgress}%` }} />
                      </div>
                    )}
                  </div>
                )}

                <div className="composer-bottom">
                  <button
                    className={`smart-pill ${forceScreenshot ? "selected" : ""}`}
                    data-tour="smart"
                    {...makeSafeClickHandlers(clickDownPosRef, () => {
                      setForceScreenshot((prev) => {
                        const next = !prev;
                        localStorage.setItem("clickr-force-screenshot", String(next));
                        return next;
                      });
                    })}
                    type="button"
                    title={
                      forceScreenshot
                        ? "Screenshot forced for every message"
                        : "Regular — auto-detect screenshots"
                    }
                  >
                    <span className="smart-icon">
                      <Icon name="wand" size={13} />
                    </span>
                    <span>Smart</span>
                    <span className="smart-chevron">
                      <Icon name="chevron" size={11} />
                    </span>
                  </button>

                  <button
                    className="composer-icon"
                    type="button"
                    title="Attach a file or image"
                    {...makeSafeClickHandlers(clickDownPosRef, handleAttachClick)}
                  >
                    <Icon name="paperclip" size={16} />
                  </button>

                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={FILE_ACCEPT_ALL}
                    onChange={handleFileSelected}
                    style={{ display: "none" }}
                  />

                  <button
                    className="composer-icon"
                    type="button"
                    title={canUse(effectiveTier, "history") ? "Conversation history" : "Conversation history (Pro)"}
                    data-history-trigger="true"
                    {...makeSafeClickHandlers(clickDownPosRef, () => {
                      if (!canUse(effectiveTier, "history")) {
                        promptUpgrade("history");
                        return;
                      }
                      setHistoryOpen((open) => !open);
                    })}
                  >
                    <Icon name="history" size={16} />
                  </button>

                  <button
                    className="composer-icon"
                    data-tour="settings"
                    type="button"
                    title="Settings"
                    {...makeSafeClickHandlers(clickDownPosRef, () => void openSettings())}
                  >
                    <Icon name="settings" size={15} />
                  </button>

                  <button
                    className={`composer-icon mode-toggle ${agentMode ? "on" : ""} ${canUse(effectiveTier, "agentMode") && agentAllowed !== false ? "" : "locked"}`}
                    type="button"
                    title={!canUse(effectiveTier, "agentMode") ? "Agent Mode (Pro+)" : agentAllowed === false ? "Agent Mode (temporarily unavailable)" : agentMode ? "Agent Mode: on" : "Agent Mode"}
                    disabled={agentRunning}
                    {...makeSafeClickHandlers(clickDownPosRef, () => {
                      if (!canUse(effectiveTier, "agentMode")) {
                        promptUpgrade("agentMode");
                        return;
                      }
                      if (agentAllowed === false) {
                        setBlockedNotice("Agent Mode is temporarily unavailable. Please try again later.");
                        window.setTimeout(() => setBlockedNotice(null), 5000);
                        return;
                      }
                      if (agentMode) {
                        setAgentMode(false);
                        return;
                      }
                      // Beta notice first: the mode only switches on once "I understand" is pressed.
                      const accepted = !!userId && localStorage.getItem(agentBetaKey(userId)) === "true";
                      if (accepted) void turnOnAgent();
                      else {
                        setAgentAccessStep(false);
                        setAgentBetaOpen(true);
                      }
                    })}
                  >
                    <Icon name="agent" size={15} />
                  </button>

                  <button
                    className={`composer-icon mode-toggle ${reasoningActive ? "on" : ""} ${canUse(effectiveTier, "reasoning") ? "" : "locked"}`}
                    type="button"
                    title={canUse(effectiveTier, "reasoning") ? (reasoningOn ? "Advanced reasoning: on" : "Advanced reasoning") : "Advanced reasoning (Pro+)"}
                    {...makeSafeClickHandlers(clickDownPosRef, () => {
                      if (!canUse(effectiveTier, "reasoning")) {
                        promptUpgrade("reasoning");
                        return;
                      }
                      setReasoningOn((on) => !on);
                    })}
                  >
                    <Icon name="bolt" size={15} />
                  </button>

                  <div className="composer-spacer" />

                  <button
                    className={`send-button ${input.trim() && !busy ? "ready" : ""}`}
                    {...makeSafeClickHandlers(clickDownPosRef, () => void handleSend())}
                    disabled={!input.trim() || busy}
                    type="button"
                    title="Send"
                  >
                    <Icon name="arrow" size={15} />
                  </button>
                </div>

                {historyOpen && (
                  <div ref={historyPopoverRef} className="history-popover">
                    {chatHistory.length > 0 && (
                      <input
                        className="history-search"
                        placeholder="Search conversations"
                        value={historyQuery}
                        onChange={(e) => setHistoryQuery(e.target.value)}
                        spellCheck={false}
                      />
                    )}
                    <div className="history-list">
                      {chatHistory.length === 0 && (
                        <div className="history-empty">No conversations yet.</div>
                      )}

                      {(() => {
                        const q = historyQuery.trim().toLowerCase();
                        const shown = q
                          ? chatHistory.filter((e) =>
                              `${e.title} ${e.messages.map((m) => m.text).join(" ")}`.toLowerCase().includes(q),
                            )
                          : chatHistory;
                        if (chatHistory.length > 0 && shown.length === 0) {
                          return <div className="history-empty">No chats match “{historyQuery}”.</div>;
                        }
                        return shown.map((entry) => (
                          <div key={entry.id} className="history-row">
                            <button
                              className="history-item"
                              type="button"
                              {...makeSafeClickHandlers(clickDownPosRef, () => openHistoryChat(entry))}
                            >
                              <span className="history-item-title">{entry.title}</span>
                              <span className="history-item-preview">{entry.preview}</span>
                            </button>
                            <button
                              type="button"
                              className="history-delete"
                              title="Delete this chat"
                              aria-label="Delete this chat"
                              {...makeSafeClickHandlers(clickDownPosRef, () => deleteChat(entry.id))}
                            >
                              <Icon name="x" size={11} />
                            </button>
                          </div>
                        ));
                      })()}
                    </div>

                    {chatHistory.length > 0 && (
                      <button
                        className="history-clear-button"
                        type="button"
                        {...makeSafeClickHandlers(clickDownPosRef, clearChatHistory)}
                      >
                        Clear history
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="prep-status">
                <img src={clickrLogoTransparent} alt="" className="prep-status-logo" />
                <span>Clickr</span>
                <span className="prep-dot">•</span>
                <span>{forceScreenshot ? "Screenshot forced" : "Regular"}</span>
              </div>
            </div>
          </div>

          {screenRecordingGranted === false && (
            <div className="permissions-overlay">
              <div className="permissions-modal-card">
                <div className="permissions-gate-icon">
                  <Icon name="sparkles" size={19} />
                </div>
                <div className="permissions-gate-title">A few permissions to set up</div>
                <div className="permissions-gate-subtitle">
                  Clickr needs these to work properly. Turn Clickr on in System Settings; if it isn&apos;t
                  listed, press the + button and add Clickr from Applications. Then restart Clickr.
                </div>

                <div className="permissions-list">
                  {PERMISSIONS.map((perm) => (
                    <div key={perm.key} className="permissions-row">
                      <span className="permissions-dot missing" />
                      <div className="permissions-row-text">
                        <div className="permissions-row-title">{perm.label}</div>
                        <div className="permissions-row-description">{perm.description}</div>
                      </div>
                      <button
                        type="button"
                        className="permissions-open-button"
                        {...makeSafeClickHandlers(clickDownPosRef, () => void openScreenRecordingSettings())}
                      >
                        Open Settings
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="permissions-restart-button"
                  {...makeSafeClickHandlers(clickDownPosRef, () => void invoke("restart_app"))}
                >
                  I've enabled it — Restart Clickr
                </button>
              </div>
            </div>
          )}

        </section>
      )}

      {deviceBlocked && (
        <div className="pricing-modal-overlay">
          <div className="pricing-modal device-blocked-card">
            <div className="pricing-modal-title">Free plan is limited to one device</div>
            <div className="pricing-modal-subtitle" style={{ margin: "8px 0 16px" }}>
              This account is already registered on another device. You can switch Clickr to this device, or upgrade to Pro to use several at once.
            </div>
            <button
              className="pricing-card-cta device-primary"
              type="button"
              disabled={takingOver}
              onClick={() => void takeOverDevice()}
            >
              {takingOver ? "Switching…" : "Use Clickr here instead"}
            </button>
            <div className="device-hint">This signs out your other device.</div>
            <button className="pricing-card-cta" style={{ marginTop: 8 }} type="button" onClick={() => promptUpgrade("multiDevice")}>
              Upgrade to use both
            </button>
            <button
              className="pricing-card-cta"
              style={{ marginTop: 8 }}
              type="button"
              onClick={() => void invoke("sign_out")}
            >
              Sign out
            </button>
          </div>
        </div>
      )}

      {agentBetaOpen && (
        <div
          className="agent-beta-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeAgentBeta();
          }}
        >
          <div className="agent-beta-card" role="dialog" aria-label="Agent Mode beta">
            <button
              type="button"
              className="agent-beta-close"
              aria-label="Close"
              onClick={closeAgentBeta}
            >
              ✕
            </button>
            {agentAccessStep ? (
              <>
                <div className="agent-beta-icon">
                  <Icon name={axGranted ? "check" : "agent"} size={20} />
                </div>
                <div className="agent-beta-title">{axGranted ? "All set" : "One more step"}</div>
                <p className="agent-beta-text">
                  {axGranted
                    ? "Accessibility is on. Turning Agent Mode on…"
                    : "To click and type for you, macOS needs your permission. Press the button, then switch Clickr on under Privacy & Security → Accessibility."}
                </p>
                {!axGranted && (
                  <>
                    <button
                      type="button"
                      className="agent-beta-confirm"
                      onClick={() => {
                        void invoke("request_accessibility");
                        window.setTimeout(() => void invoke("open_system_settings_pane", { pane: "accessibility" }), 700);
                      }}
                    >
                      Allow Accessibility
                    </button>
                    <div className="agent-beta-waiting">
                      <span className="status-spinner" /> Waiting for you to allow it…
                    </div>
                    <button type="button" className="bug-link" onClick={closeAgentBeta}>
                      Not now
                    </button>
                  </>
                )}
              </>
            ) : (
            <>
            <div className="agent-beta-icon">
              <Icon name="agent" size={20} />
            </div>
            <div className="agent-beta-title">
              Agent Mode <span className="agent-beta-tag">Beta</span>
            </div>
            <p className="agent-beta-text">
              Agent Mode is currently in beta and is still being worked on. It can click, type, open apps and
              manage files on your Mac, so it may sometimes get things wrong.
            </p>
            <ul className="agent-beta-list">
              <li>It asks before it acts, unless you choose “Allow all”.</li>
              <li>Press Stop (or your show/hide shortcut) at any time to end a run.</li>
              <li>Keep an eye on it, and don&apos;t use it for anything you can&apos;t undo.</li>
            </ul>
            <button
              type="button"
              className="agent-beta-confirm"
              onClick={() => {
                if (userId) localStorage.setItem(agentBetaKey(userId), "true");
                void ensureNotificationPermission(); // so we can tell you when a run finishes
                void turnOnAgent();
              }}
            >
              I understand
            </button>
            </>
            )}
          </div>
        </div>
      )}

      {pricingModalOpen && (
        <PricingModal
          userId={userId}
          currentTier={currentTier}
          feature={pricingFeature}
          onPurchaseStarted={() => {
            setAwaitingPurchase(true);
            setPricingModalOpen(false);
            void hideForPurchase();
          }}
          onClose={() => {
            setPricingModalOpen(false);
            setPricingFeature(null);
          }}
        />
      )}
      
      {isDraggingFile && (
        <div className="drop-zone-overlay">
          <div className="drop-zone-box">
            <div className="drop-zone-icon">
              <Icon name="image" size={26} />
            </div>
            <div className="drop-zone-title">Drop image to upload</div>
          </div>
        </div>
      )}

      {tourActive && spotlight && (
        <>
          <div
            className="onboarding-spotlight"
            style={{
              top: `${spotlight.top - 7}px`,
              left: `${spotlight.left - 7}px`,
              width: `${spotlight.width + 14}px`,
              height: `${spotlight.height + 14}px`,
            }}
          />

          <div
            ref={tourCardRef}
            className="onboarding-card"
            style={
              tourCardPosition
                ? {
                    top: `${tourCardPosition.top}px`,
                    left: `${tourCardPosition.left}px`,
                    transform: "none",
                  }
                : {
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                  }
            }
          >
            <div className="onboarding-step">
              {tourStep + 1} of {TOUR_STEPS.length}
            </div>
            <div className="onboarding-title">{TOUR_STEPS[tourStep].title}</div>
            <div className="onboarding-description">{TOUR_STEPS[tourStep].description}</div>

            <div className="onboarding-actions">
              <button className="onboarding-skip" type="button" {...makeSafeClickHandlers(clickDownPosRef, skipTour)}>
                Skip
              </button>
              <button className="onboarding-next" type="button" {...makeSafeClickHandlers(clickDownPosRef, nextTourStep)}>
                {tourStep === TOUR_STEPS.length - 1 ? "Get Started" : "Next"}
                {tourStep !== TOUR_STEPS.length - 1 && <Icon name="arrow" size={14} />}
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}