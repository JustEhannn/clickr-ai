// Frontend half of Agent Mode: describes tool calls in plain language and
// decides which ones need the user's approval. The loop itself lives in
// App.tsx (it needs chat state); execution happens in Rust (agent.rs).

export type AgentCall = { name: string; args: Record<string, unknown> };

/** Tools that change state (screen input or files) — these need approval. */
const NEEDS_APPROVAL = new Set([
  "press_element",
  "click",
  "type_text",
  "press_key",
  "scroll",
  "write_file",
  "make_dir",
  "move_file",
  "trash_file",
]);

export function needsApproval(call: AgentCall): boolean {
  return NEEDS_APPROVAL.has(call.name);
}

export function usesComputerControl(call: AgentCall): boolean {
  return ["click", "type_text", "press_key", "scroll", "press_element", "list_ui_elements"].includes(call.name);
}

const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));

/** Parses the list_ui_elements result into id -> "role “label”" for readable approvals. */
export function parseElementList(result: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of result.split("\n")) {
    const m = line.match(/^\[(\d+)\]\s+(\w+)\s+(.*?)\s+at x=/);
    if (m) map.set(Number(m[1]), `${m[3] === "(no label)" ? "" : m[3] + " "}${m[2].toLowerCase()}`.trim());
  }
  return map;
}

export function describeCall({ name, args }: AgentCall, elements?: Map<number, string>): string {
  switch (name) {
    case "click":
      return `${args.double ? "Double-click" : args.button === "right" ? "Right-click" : "Click"} on screen`;
    case "type_text":
      return `Type “${str(args.text).slice(0, 80)}${str(args.text).length > 80 ? "…" : ""}”`;
    case "press_key": {
      const mods = Array.isArray(args.modifiers) ? (args.modifiers as string[]).join("+") + "+" : "";
      return `Press ${mods}${str(args.key)}`;
    }
    case "scroll":
      return `Scroll ${Number(args.amount) >= 0 ? "down" : "up"}`;
    case "list_ui_elements":
      return "Look at the app's controls";
    case "press_element":
      return `Press ${elements?.get(Number(args.id)) ?? "a control"}`;
    case "wait":
      return `Wait ${str(args.seconds)}s`;
    case "open_url":
      return `Open ${str(args.url)}`;
    case "open_app":
      return `Open ${str(args.name)}`;
    case "list_files":
      return `List ${str(args.path)}`;
    case "read_file":
      return `Read ${str(args.path)}`;
    case "write_file":
      return `Write file ${str(args.path)}`;
    case "make_dir":
      return `Create folder ${str(args.path)}`;
    case "move_file":
      return `Move ${str(args.from)} → ${str(args.to)}`;
    case "trash_file":
      return `Move ${str(args.path)} to Trash`;
    default:
      return name;
  }
}

/**
 * Actions that probably change the page (submit, next question, navigation). The
 * rest of a batch is skipped after them so the agent looks at the new screen first
 * instead of clicking where the old page's buttons used to be.
 */
export function endsBatch(call: AgentCall, elementLabel?: string): boolean {
  if (call.name === "press_key") {
    const key = String(call.args.key ?? "").toLowerCase();
    return key === "return" || key === "enter";
  }
  if (call.name === "press_element" || call.name === "click") {
    return /\b(submit|next|check|done|continue|send|save|finish|ok|go|search|login|log in|sign in|confirm|enter|answer|apply|buy|pay|order|delete|remove)\b/i.test(elementLabel ?? "");
  }
  return call.name === "open_url" || call.name === "open_app";
}
