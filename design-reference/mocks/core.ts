// Fake backend: answers every command the UI calls with believable demo data.
import { emit } from "./event";
import { demo, tier } from "./params";

// The tour scene uses its own fake account so other scenes can't mark the tour as "already seen".
const DEMO_USER = demo === "tour" ? "demo-tour" : "demo-user";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in "screenshot" so screen-aware features have something to show. */
function fakeScreenshot(): string {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 400;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1b2433";
  g.fillRect(0, 0, 640, 400);
  g.fillStyle = "#2b3a52";
  g.fillRect(24, 24, 592, 40);
  return c.toDataURL("image/jpeg", 0.6).split(",")[1];
}

const ANSWER = `Looking at your screen, you're in a spreadsheet with quarterly revenue. Here's what stands out:

- **Q3 revenue is up 18%** on Q2, driven mostly by the Pro plan
- Churn dipped slightly, from 3.1% to 2.7%
- The *EMEA* column is missing its total, so the sum in the footer is off

If you'd like, I can write the formula to fix the footer: \`=SUM(C2:C14)\`.`;

const memories = [
  { id: "m1", content: "I work in product design and prefer short, direct answers." },
  { id: "m2", content: "My team uses Figma and Linear every day." },
];

const commands: Record<string, (args: any) => unknown> = {
  get_session: () => ({ signed_in: true, email: "alex@example.com", user_id: DEMO_USER }),
  get_subscription: () => ({
    tier,
    status: "active",
    billing_cycle: "monthly",
    current_period_end: new Date(Date.now() + 20 * 86400000).toISOString(),
  }),
  check_screen_recording_permission: () => demo !== "perm",
  check_accessibility: () => true,
  request_accessibility: () => true,
  check_ai: () => "ok",
  register_device: () => true,
  agent_access: () => tier === "pro_plus",
  get_linked_providers: () => [{ id: "g1", provider: "google" }],
  list_memories: () => memories,
  add_memory: (a) => ({ id: "m" + Math.random(), content: a?.content ?? "" }),
  list_custom_models: () => [{ id: "c1", name: "My GPT-5", base_url: "https://api.example.com/v1", model: "gpt-5" }],
  pull_history: () => [],
  capture_screenshot: () => fakeScreenshot(),
  get_active_app: () => "Numbers",
  bug_diagnostics: () => ({ app_version: "0.1.1", os: "macOS 15", plan: tier }),
  ask_ai: async (a) => {
    const id = a?.streamId;
    if (demo === "limit") throw { kind: "limit_reached", retry_after_seconds: 3 * 3600 + 24 * 60 };
    await sleep(700);
    const words = ANSWER.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 3) {
      await emit("ask-delta", { id, text: words.slice(i, i + 3).join("") });
      await sleep(35);
    }
    return ANSWER;
  },
};

export async function invoke<T = unknown>(cmd: string, args?: any): Promise<T> {
  const fn = commands[cmd];
  return (fn ? await fn(args) : undefined) as T;
}
export const convertFileSrc = (p: string) => p;
