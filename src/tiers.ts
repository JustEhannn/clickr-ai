// Single source of truth for what each plan includes and which app features
// are locked behind which tier. The pricing modal renders from PLANS, and
// every client-side gate goes through canUse() so changing a feature's tier
// is a one-line edit here.
//
// NOTE: this is UX gating only. Anything that costs money or touches user
// data must ALSO be enforced server-side (Edge Functions / RLS).

import { DEVICE_NAME } from "./platform";

export type Tier = "free" | "pro" | "pro_plus";

export const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, pro_plus: 2 };

export type Feature =
  | "history"
  | "historySync"
  | "customHotkeys"
  | "customModels"
  | "multiMonitor"
  | "appAware"
  | "memory"
  | "advancedFiles"
  | "multiFile"
  | "multiDevice"
  | "agentMode"
  | "reasoning"
  | "beta"
  | "prioritySupport";

const MIN_TIER: Record<Feature, Tier> = {
  history: "pro",
  historySync: "pro",
  customHotkeys: "pro",
  customModels: "pro_plus",
  multiMonitor: "pro",
  appAware: "pro",
  memory: "pro",
  advancedFiles: "pro",
  multiFile: "pro",
  multiDevice: "pro",
  agentMode: "pro_plus",
  reasoning: "pro_plus",
  beta: "pro_plus",
  prioritySupport: "pro_plus",
};

/** Shown in upgrade prompts: "<label> is a <plan> feature." */
export const FEATURE_LABELS: Record<Feature, string> = {
  history: "Conversation History",
  historySync: "Multi-device sync",
  customHotkeys: "Custom Hotkeys",
  customModels: "Custom AI Models",
  multiMonitor: "Multi-Monitor Support",
  appAware: "App-Aware Assistance",
  memory: "Memory & Context",
  advancedFiles: "PDF & code file analysis",
  multiFile: "Attaching several files at once",
  multiDevice: "Multiple devices",
  agentMode: "Agent Mode",
  reasoning: "Advanced Reasoning Models",
  beta: "Early Access & Beta Features",
  prioritySupport: "Priority Support",
};

/** Free tier: images and plain text. Pro: PDFs and source code too. */
const BASIC_FILE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "txt", "md", "csv"]);

export function fileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

/** Returns true if `tier` may attach a file with this name. */
export function canAttachFile(tier: Tier | null, name: string): boolean {
  return canUse(tier, "advancedFiles") || BASIC_FILE_EXTENSIONS.has(fileExtension(name));
}

export const FILE_ACCEPT_ALL =
  "image/*,.pdf,.txt,.md,.csv,.rs,.py,.js,.jsx,.ts,.tsx,.java,.c,.h,.cpp,.cs,.go,.rb,.php,.swift,.kt,.sh,.sql,.html,.css,.json,.yaml,.yml,.toml,.xml";

export function canUse(tier: Tier | null, feature: Feature): boolean {
  return TIER_RANK[tier ?? "free"] >= TIER_RANK[MIN_TIER[feature]];
}

export function minTierFor(feature: Feature): Tier {
  return MIN_TIER[feature];
}

export function planNameFor(feature: Feature): string {
  return tierLabel(MIN_TIER[feature]);
}

export function tierLabel(tier: Tier | string | null): string {
  if (tier === "pro") return "Pro";
  if (tier === "pro_plus") return "Pro+";
  return "Free";
}

export type Plan = {
  tier: Tier;
  name: string;
  tagline: string;
  /** Price per month when billed monthly / annually. */
  monthly: string;
  annual: string;
  inherits?: string;
  /** Shown above the feature list for the plan's flagship feature. */
  headline?: { title: string; note?: string };
  features: string[];
  popular?: boolean;
};

export const PLANS: Plan[] = [
  {
    tier: "free",
    name: "Free",
    tagline: "For trying Clickr on your own screen",
    monthly: "$0",
    annual: "$0",
    features: [
      "AI Chat",
      "Basic Screen Understanding",
      "Screenshot Analysis",
      "Ask Questions About Your Screen",
      "Web Search (daily limit)",
      "Basic File Analysis (images & text)",
      "Device Context Awareness",
      "Limited Daily Usage",
      "Single Device",
    ],
  },
  {
    tier: "pro",
    name: "Pro",
    tagline: "For people who use Clickr every day",
    monthly: "$9.99",
    annual: "$7.99",
    popular: true,
    inherits: "Everything in Free",
    features: [
      "Higher Screen Understanding Limits",
      "Memory & Context",
      "Multi-Monitor Support",
      "Advanced File Analysis",
      "Attach Several Files at Once",
      "PDF Understanding",
      "Image Understanding",
      "Code File Analysis",
      "App-Aware Assistance",
      "Priority Response Speed",
      "Multiple Devices Sync",
      "Custom Hotkeys",
      "Conversation History",
      "Higher Web Search Limit",
      "Higher Usage Limits",
    ],
  },
  {
    tier: "pro_plus",
    name: "Pro+",
    tagline: "For power users",
    monthly: "$19.99",
    annual: "$16.99",
    inherits: "Everything in Pro",
    headline: {
      title: "Agent Mode",
      note: `Clickr works your ${DEVICE_NAME} for you — and you watch every move.`,
    },
    features: [
      "Clicks, types & navigates your apps and websites",
      "Creates, moves & organizes your files",
      "Completes multi-step tasks — asks before it acts",
      "Custom AI Models",
      "Advanced Reasoning Models",
      "Early Access & Beta Features",
      "Priority Support",
      "Highest Usage Limits",
    ],
  },
];
