// The free open models Clickr can run, strongest first. Sizes are the download size shown on
// ollama.com/library (checked November 2026); "minRam" is a rough memory guide, not a guarantee.
// Quality is ranked by model generation and size, not by a benchmark: bigger is smarter but slower.

export type ModelOption = {
  tag: string; // the name Ollama downloads, e.g. "qwen3.5:4b"
  name: string;
  sizeGB: number;
  minRam: number; // GB of computer memory for it to run comfortably
  quality: "Best" | "Excellent" | "Very good" | "Good" | "Decent" | "Basic";
  vision: boolean; // can look at your screen and images
  agent: boolean; // can use tools, which Agent Mode needs
  blurb: string;
};

export const MODELS: ModelOption[] = [
  { tag: "qwen3.8:27b", name: "Qwen 3.8 27B", sizeGB: 18, minRam: 32, quality: "Best", vision: true, agent: true, blurb: "The strongest free model here. Needs a powerful Mac." },
  { tag: "gemma4:31b", name: "Gemma 4 31B", sizeGB: 20, minRam: 32, quality: "Excellent", vision: true, agent: true, blurb: "Google's largest open model. Great all-rounder." },
  { tag: "gemma4:26b", name: "Gemma 4 26B", sizeGB: 17, minRam: 24, quality: "Excellent", vision: true, agent: true, blurb: "Almost as strong, a little lighter." },
  { tag: "qwen3.5:9b", name: "Qwen 3.5 9B", sizeGB: 6.6, minRam: 16, quality: "Very good", vision: true, agent: true, blurb: "Best balance of smart and fast on most Macs." },
  { tag: "gemma4:e4b", name: "Gemma 4 E4B", sizeGB: 6.6, minRam: 16, quality: "Very good", vision: true, agent: true, blurb: "Efficient Google model, strong for its size." },
  { tag: "qwen3-vl:8b", name: "Qwen 3 VL 8B", sizeGB: 6.2, minRam: 16, quality: "Good", vision: true, agent: true, blurb: "Built for reading screens and images." },
  { tag: "qwen3.5:4b", name: "Qwen 3.5 4B", sizeGB: 3.4, minRam: 8, quality: "Good", vision: true, agent: true, blurb: "Best pick for an 8 GB Mac." },
  { tag: "gemma3:4b", name: "Gemma 3 4B", sizeGB: 3.4, minRam: 8, quality: "Decent", vision: true, agent: false, blurb: "Small and quick. No Agent Mode." },
  { tag: "qwen3.5:2b", name: "Qwen 3.5 2B", sizeGB: 1.9, minRam: 8, quality: "Basic", vision: true, agent: true, blurb: "Tiny and fast. Fine for simple questions." },
];

/** The strongest model that fits this computer's memory (falls back to the smallest). */
export function recommended(ramGB: number): ModelOption {
  return MODELS.find((m) => m.minRam <= ramGB) ?? MODELS[MODELS.length - 1];
}
