// The free open models Clickr can run, strongest first. Each is a 4-bit GGUF from Hugging Face; sizes
// are the real download (model + vision file) as of November 2026. "minRam" is a rough guide.
// Quality is ranked by model generation and size, not by a benchmark: bigger is smarter but slower.

export type ModelOption = {
  tag: string; // our id for the model, e.g. "qwen3.5:4b"
  repo: string; // the Hugging Face GGUF repository it downloads from
  name: string;
  sizeGB: number;
  minRam: number; // GB of computer memory for it to run comfortably
  quality: "Best" | "Excellent" | "Very good" | "Good" | "Decent" | "Basic";
  vision: boolean; // can look at your screen and images
  agent: boolean; // can use tools, which Agent Mode needs
  blurb: string;
};

export const MODELS: ModelOption[] = [
  { tag: "qwen3.8:27b", repo: "unsloth/Qwen3.8-27B-GGUF", name: "Qwen 3.8 27B", sizeGB: 17.5, minRam: 32, quality: "Best", vision: true, agent: true, blurb: "The strongest free model here. Needs a powerful Mac." },
  { tag: "gemma4:31b", repo: "unsloth/gemma-4-31B-it-GGUF", name: "Gemma 4 31B", sizeGB: 19.5, minRam: 32, quality: "Excellent", vision: true, agent: true, blurb: "Google's largest open model. Great all-rounder." },
  { tag: "gemma4:26b", repo: "unsloth/gemma-4-26B-A4B-it-GGUF", name: "Gemma 4 26B", sizeGB: 18.1, minRam: 24, quality: "Excellent", vision: true, agent: true, blurb: "Almost as strong, a little lighter." },
  { tag: "qwen3.5:9b", repo: "unsloth/Qwen3.5-9B-GGUF", name: "Qwen 3.5 9B", sizeGB: 6.6, minRam: 16, quality: "Very good", vision: true, agent: true, blurb: "Best balance of smart and fast on most Macs." },
  { tag: "gemma4:e4b", repo: "unsloth/gemma-4-E4B-it-GGUF", name: "Gemma 4 E4B", sizeGB: 6.0, minRam: 16, quality: "Very good", vision: true, agent: true, blurb: "Efficient Google model, strong for its size." },
  { tag: "qwen3-vl:8b", repo: "unsloth/Qwen3-VL-8B-Instruct-GGUF", name: "Qwen 3 VL 8B", sizeGB: 6.2, minRam: 16, quality: "Good", vision: true, agent: true, blurb: "Built for reading screens and images." },
  { tag: "qwen3.5:4b", repo: "unsloth/Qwen3.5-4B-GGUF", name: "Qwen 3.5 4B", sizeGB: 3.4, minRam: 8, quality: "Good", vision: true, agent: true, blurb: "Best pick for an 8 GB Mac." },
  { tag: "gemma3:4b", repo: "unsloth/gemma-3-4b-it-GGUF", name: "Gemma 3 4B", sizeGB: 3.4, minRam: 8, quality: "Decent", vision: true, agent: false, blurb: "Small and quick. No Agent Mode." },
  { tag: "qwen3.5:2b", repo: "unsloth/Qwen3.5-2B-GGUF", name: "Qwen 3.5 2B", sizeGB: 2.0, minRam: 8, quality: "Basic", vision: true, agent: true, blurb: "Tiny and fast. Fine for simple questions." },
];

/** The strongest model that fits this computer's memory (falls back to the smallest). */
export function recommended(ramGB: number): ModelOption {
  return MODELS.find((m) => m.minRam <= ramGB) ?? MODELS[MODELS.length - 1];
}

/**
 * Optional models that use the person's own Claude or ChatGPT subscription through the official
 * `claude` / `codex` programs. Unlike the local models above, their questions and screen go to
 * Anthropic / OpenAI.
 */
export type SubscriptionModel = {
  tag: string; // "<program>:<model>"
  program: "claude" | "codex";
  name: string;
  blurb: string;
};

export const SUBSCRIPTION_MODELS: SubscriptionModel[] = [
  { tag: "claude:opus", program: "claude", name: "Claude Opus", blurb: "Strongest Claude. Best for Agent Mode." },
  { tag: "claude:sonnet", program: "claude", name: "Claude Sonnet", blurb: "Fast and very capable." },
  { tag: "claude:haiku", program: "claude", name: "Claude Haiku", blurb: "Fastest, lightest on your usage limit." },
  { tag: "codex:default", program: "codex", name: "ChatGPT (Codex)", blurb: "Uses the model your Codex login picks. Not tested yet." },
];

/** Display name for any model tag, local or subscription. */
export function modelName(tag: string): string {
  return MODELS.find((m) => m.tag === tag)?.name ?? SUBSCRIPTION_MODELS.find((m) => m.tag === tag)?.name ?? tag;
}
