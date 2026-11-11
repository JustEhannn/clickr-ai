// Clickr is free and open source: every feature is available to everyone.
// canUse() is kept so call sites read the same, and so a feature could be switched off in one place.

export type Tier = "free" | "pro" | "pro_plus";

export type Feature =
  | "history"
  | "historySync"
  | "customModels"
  | "beta"
  | "multiDevice"
  | "customHotkeys"
  | "multiMonitor"
  | "appAware"
  | "memory"
  | "advancedFiles"
  | "multiFile"
  | "agentMode"
  | "reasoning";

export function canUse(_tier: Tier | null | undefined, _feature: Feature): boolean {
  return true;
}

export function fileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

/** Returns true if `tier` may attach a file with this name. */
export function canAttachFile(_tier: Tier | null, _name: string): boolean {
  return true;
}

export const FILE_ACCEPT_ALL =
  "image/*,.pdf,.txt,.md,.csv,.rs,.py,.js,.jsx,.ts,.tsx,.java,.c,.h,.cpp,.cs,.go,.rb,.php,.swift,.kt,.sh,.sql,.html,.css,.json,.yaml,.yml,.toml,.xml";

