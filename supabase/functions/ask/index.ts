// supabase/functions/ask/index.ts
// Clickr's AI gateway: verify login -> meter quota -> route model -> call provider.
// Deploy: supabase functions deploy ask
// Secrets: supabase secrets set GEMINI_API_KEY=...   (SUPABASE_URL and the service key are injected automatically)
//
// Request  (POST, header "Authorization: Bearer <user access token>"):
//   { "question": string,
  //     "screenshot"?: { "mime": "image/jpeg", "data": "<base64>" },
  //     "attachment"?: { "mime": "image/png",  "data": "<base64>" } }
// Response 200: { "answer": string }
// Response 429: { "error": "limit_reached", "reason": "quota" | "attachment_limit",
  //                 "retry_after_seconds": number, "show_pricing": true }
// Other errors: { "error": string, "message"?: string }
//
// The response never says which model answered or whether the user was downgraded.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;

// Until Claude is wired in, any non-Gemini model in tier_config falls back to this.
const REASONING_MODEL = Deno.env.get("REASONING_MODEL") ?? "gemini-pro-latest";

// Claude (Pro+ escalation). Set ANTHROPIC_API_KEY to switch it on; without it
// Pro+ simply stays on Gemini 2.5 Pro. Model IDs can be overridden with secrets.
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CLAUDE_SONNET = Deno.env.get("CLAUDE_SONNET_MODEL") ?? "claude-sonnet-4-6";
const CLAUDE_OPUS = Deno.env.get("CLAUDE_OPUS_MODEL") ?? "claude-opus-4-8";
// "-latest" aliases follow Google's current model, so a retirement can't 404 us again.
// Everyday questions on Pro/Pro+ go to a fast model; only harder ones wait for the big Pro model.
const FAST_MODEL = Deno.env.get("FAST_GEMINI_MODEL") ?? "gemini-3.8-flash";
const PRO_MODEL = Deno.env.get("PRO_MODEL") ?? "gemini-pro-latest";
const DEFAULT_GEMINI_MODEL = Deno.env.get("DEFAULT_GEMINI_MODEL") ?? "gemini-3.5-flash-lite";

const SYSTEM_PROMPT = `
You are Clickr.

Be concise.
Use screenshots only when needed.
Format code using markdown code blocks.
Format equations using markdown math.
Prefer direct answers.

When a screenshot is provided, use it only as visual context relevant to the user's request.
Do not describe the screenshot unless that helps answer the question.

A "Clickr background context" block may precede the user's message (time, active app,
saved memories, recent conversation). Use it silently when relevant; never recite it.
For anything recent or factual that may have changed, search the web and answer from the results.
`;

const MAX_QUESTION_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 20_000; // device info, memories, recent turns sent by the app
const MAX_IMAGE_B64_CHARS = 8_000_000; // ~6 MB decoded; Edge Functions have 256 MB memory
const PROVIDER_TIMEOUT_MS = 90_000; // platform response timeout is 150 s
const ALLOWED_MIME = new Set([
    "image/png", "image/jpeg", "image/webp",
    "application/pdf", "text/plain", "text/markdown", "text/csv",
  ]);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

type Img = { mime: string; data: string };
type AskBody = {
  question?: unknown;
  screenshot?: unknown;
  attachment?: unknown;
  attachments?: unknown;
  context?: unknown;
  ping?: unknown;
  stream?: unknown;
  custom_model_id?: unknown;
  reasoning?: unknown;
  web_search?: unknown;
};

const json = (status: number, body: unknown) =>
new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function parseImage(v: unknown): Img | null | "invalid" {
  if (v === undefined || v === null) return null;
  const o = v as { mime?: unknown; data?: unknown };
  if (typeof o.mime !== "string" || typeof o.data !== "string") return "invalid";
  if (!ALLOWED_MIME.has(o.mime) || o.data.length === 0 || o.data.length > MAX_IMAGE_B64_CHARS) {
    return "invalid";
  }
  return { mime: o.mime, data: o.data };
}

class ProviderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function askGemini(
  model: string,
  question: string,
  images: Img[],
  context: string,
  webSearch: boolean,
): Promise<{ text: string; searched: boolean }> {
  // Images first, then text.
  const parts: unknown[] = images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } }));
  parts.push({ text: context ? `${context}\n\nUser message:\n${question}` : question });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts }],
          // Gemini 3 models work best at their default temperature.
          ...(model.startsWith("gemini-2") ? { generationConfig: { temperature: 0.4 } } : {}),
        // Gemini decides on its own whether a question needs a live search.
        ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
        }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    // Raw detail goes to the function logs only, never to the user.
    const errText = (await res.text()).slice(0, 500);
    console.error("gemini error", res.status, errText);
    throw new ProviderError(res.status, `Gemini ${model} -> HTTP ${res.status}: ${errText.replace(/\s+/g, " ").slice(0, 280)}`);
  }

  const data = await res.json();
  const text: string = (data?.candidates?.[0]?.content?.parts ?? [])
  .map((p: { text?: string }) => p.text ?? "")
  .join("")
  .trim();
  if (!text) throw new ProviderError(0, "empty_response");
  // Only a search that actually ran counts against the daily quota.
  const searched = (data?.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length ?? 0) > 0;
  return { text, searched };
}


/** A small "think less" setting per model family; null = leave the model alone. */
function thinkingHints(model: string): Array<Record<string, unknown> | null> {
  const isGemini3 = model.startsWith("gemini-3") || /^gemini-(flash|pro)/.test(model);
  if (!isGemini3) return [null];
  const isPro = model.includes("pro");
  // Flash models can think "minimal"; Pro's lowest is "low". Each step falls back if rejected.
  return isPro ? [{ thinkingLevel: "low" }, null] : [{ thinkingLevel: "minimal" }, { thinkingLevel: "low" }, null];
}

type Route = { provider: "gemini" | "claude"; model: string; label: string };

/**
 * Rough difficulty score from the question alone — no extra model call, so
 * routing adds no latency. The result is logged in usage_events.model so the
 * 70/25/5 split can be checked and tuned.
 */
function difficulty(question: string, hasPdf: boolean): "simple" | "hard" | "hardest" {
  const q = question;
  let score = 0;
  if (q.length > 300) score += 1;
  if (q.length > 900) score += 2;
  if (q.length > 2000) score += 2;
  if (/```|\bdef \w+\(|\bfunction\b|\bclass \w+|=>|traceback|stack ?trace|exception|compile|refactor|debug|regex|\bsql\b|algorithm|big-?o/i.test(q)) score += 2;
  if (/\b(prove|proof|derive|derivation|theorem|optimi[sz]e|architecture|design a|trade-?offs?|step by step|analy[sz]e|compare and contrast|strategy|diagnos|legal|contract)\b/i.test(q)) score += 2;
  if (/\b(integral|matrix|equation|calculus|probability|differential)\b/i.test(q)) score += 1;
  if ((q.match(/\?/g) ?? []).length >= 3 || /^\s*\d+[.)]\s/m.test(q)) score += 1;
  if (hasPdf) score += 1;
  return score >= 6 ? "hardest" : score >= 3 ? "hard" : "simple";
}

/**
 * Free:  Gemini 2.5 Flash-Lite (hard cooldown when capped — handled by the quota gate).
 * Pro:   Gemini 2.5 Pro; Flash-Lite after the daily cap.
 * Pro+:  Gemini 2.5 Pro for most traffic; Claude Sonnet for harder questions;
 *        Claude Opus for the hardest or when Advanced Reasoning is on. Once the
 *        fair-use ceiling is passed (escalation_allowed = false) it stays on Pro.
 */
function chooseRoute(opts: {
  tier: string;
  degraded: boolean;
  escalationAllowed: boolean;
  primary: string | null;
  fallback: string | null;
  question: string;
  reasoning: boolean;
  webSearch: boolean;
  hasPdf: boolean;
}): Route {
  const geminiBase = (opts.degraded ? opts.fallback : opts.primary);
  const base = geminiBase?.startsWith("gemini") ? geminiBase : opts.tier === "free" ? DEFAULT_GEMINI_MODEL : PRO_MODEL;

  if (opts.tier === "pro_plus" && ANTHROPIC_KEY && opts.escalationAllowed && !opts.webSearch) {
    const level = opts.reasoning ? "hardest" : difficulty(opts.question, opts.hasPdf);
    if (level === "hardest") return { provider: "claude", model: CLAUDE_OPUS, label: CLAUDE_OPUS };
    if (level === "hard") return { provider: "claude", model: CLAUDE_SONNET, label: CLAUDE_SONNET };
  }

  // Advanced Reasoning without Claude available still gets the Pro model.
  if (opts.reasoning && opts.tier === "pro_plus") return { provider: "gemini", model: REASONING_MODEL, label: REASONING_MODEL };

  // Paid plans: easy questions use the fast model so the first words arrive in about a second.
  if ((opts.tier === "pro" || opts.tier === "pro_plus") && !opts.degraded && difficulty(opts.question, opts.hasPdf) === "simple") {
    return { provider: "gemini", model: FAST_MODEL, label: FAST_MODEL };
  }
  return { provider: "gemini", model: base, label: base };
}

/** Opens a streaming Claude request (SSE). */
async function openClaudeStream(model: string, question: string, images: Img[], context: string): Promise<Response> {
  const blocks: unknown[] = [];
  let inlineText = "";
  for (const i of images) {
    if (i.mime.startsWith("image/")) {
      blocks.push({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } });
    } else if (i.mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: i.data } });
    } else if (i.mime.startsWith("text/")) {
      inlineText += `\n\n[Attached file]\n${new TextDecoder().decode(Uint8Array.from(atob(i.data), (c) => c.charCodeAt(0)))}`;
    }
  }
  blocks.push({ type: "text", text: (context ? `${context}\n\nUser message:\n${question}` : question) + inlineText });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: model === CLAUDE_OPUS ? 4096 : 3072,
      stream: true,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: blocks }],
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errText = (await res.text()).slice(0, 400);
    console.error("claude stream error", res.status, errText);
    throw new ProviderError(res.status, `Claude ${model} -> HTTP ${res.status}: ${errText.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  return res;
}

/** Opens a streaming Gemini request. Retries once without the thinking hint if the model rejects it. */
async function openGeminiStream(
  model: string,
  question: string,
  images: Img[],
  context: string,
  webSearch: boolean,
  fast: boolean,
): Promise<Response> {
  const parts: unknown[] = images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } }));
  parts.push({ text: context ? `${context}\n\nUser message:\n${question}` : question });

  const build = (hint: Record<string, unknown> | null) =>
    JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        ...(model.startsWith("gemini-2") ? { temperature: 0.4 } : {}),
        // Everyday questions don't need long hidden reasoning; it's the main source of delay.
        ...(hint ? { thinkingConfig: hint } : {}),
      },
      ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
    });

  const call = (body: string) =>
    fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );

  const ladder = fast ? thinkingHints(model) : [null];
  let res = await call(build(ladder[0]));
  for (let i = 1; i < ladder.length && res.status === 400; i++) res = await call(build(ladder[i]));

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 500);
    console.error("gemini stream error", res.status, errText);
    throw new ProviderError(res.status, `Gemini ${model} -> HTTP ${res.status}: ${errText.replace(/\s+/g, " ").slice(0, 280)}`);
  }
  return res;
}

// ---- Custom (bring-your-own) models: Pro+ -----------------------------
type CustomModel = { provider: string; base_url: string | null; model_id: string; api_key: string };

function assertSafeBaseUrl(raw: string): string {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === "::1";
  if (u.protocol !== "https:" || privateHost) throw new ProviderError(400, "bad_base_url");
  return u.toString().replace(/\/+$/, "");
}

async function askCustom(m: CustomModel, question: string, images: Img[], context: string): Promise<string> {
  const text = context ? `${context}\n\nUser message:\n${question}` : question;
  const visual = images.filter((i) => i.mime.startsWith("image/"));
  const inlineText = images
    .filter((i) => i.mime.startsWith("text/"))
    .map((i) => `\n\n[Attached file]\n${new TextDecoder().decode(Uint8Array.from(atob(i.data), (c) => c.charCodeAt(0)))}`)
    .join("");
  if (images.some((i) => i.mime === "application/pdf")) throw new ProviderError(400, "pdf_unsupported");
  const prompt = text + inlineText;

  if (m.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": m.api_key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: m.model_id,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            ...visual.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
            { type: "text", text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) { console.error("custom anthropic", res.status, (await res.text()).slice(0, 300)); throw new ProviderError(res.status, "custom_http_error"); }
    const d = await res.json();
    const out = (d?.content ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
    if (!out) throw new ProviderError(0, "empty_response");
    return out;
  }

  if (m.provider === "gemini") {
    const parts: unknown[] = visual.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } }));
    parts.push({ text: prompt });
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m.model_id)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": m.api_key },
        body: JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: "user", parts }] }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (!res.ok) { console.error("custom gemini", res.status, (await res.text()).slice(0, 300)); throw new ProviderError(res.status, "custom_http_error"); }
    const d = await res.json();
    const out = (d?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
    if (!out) throw new ProviderError(0, "empty_response");
    return out;
  }

  // "openai" and "openai_compatible" (OpenRouter, Groq, Together, LM Studio over https, …)
  const base = m.provider === "openai" || !m.base_url ? "https://api.openai.com/v1" : assertSafeBaseUrl(m.base_url);
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.api_key}` },
    body: JSON.stringify({
      model: m.model_id,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            ...visual.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) { console.error("custom openai", res.status, (await res.text()).slice(0, 300)); throw new ProviderError(res.status, "custom_http_error"); }
  const d = await res.json();
  const out: string = (d?.choices?.[0]?.message?.content ?? "").trim();
  if (!out) throw new ProviderError(0, "empty_response");
  return out;
}

async function tierOf(userId: string): Promise<string> {
  const { data } = await admin.from("subscriptions").select("tier").eq("user_id", userId).maybeSingle();
  return data?.tier ?? "free";
}

Deno.serve(async (req) => {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    // 1. Who is asking?
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "not_signed_in" });
    const { data: auth, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !auth?.user) return json(401, { error: "not_signed_in" });
    const userId = auth.user.id;

    // 2. Validate input.
    let body: AskBody;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "bad_request" });
    }
    // Health check used by the app's status dot: verifies the Gemini key works
    // without using any quota.
    if (body.ping === true) {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
        headers: { "x-goog-api-key": GEMINI_KEY },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (res?.ok) return json(200, { ok: true });
      console.error("gemini ping failed", res?.status);
      return json(502, {
        error: "provider_unavailable",
        message: res?.status === 400 || res?.status === 403
          ? "The Gemini API key was rejected. Check the GEMINI_API_KEY secret."
          : "Couldn't reach Gemini.",
      });
    }

    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question || question.length > MAX_QUESTION_CHARS) return json(400, { error: "bad_question" });

    const context = typeof body.context === "string" ? body.context.trim().slice(0, MAX_CONTEXT_CHARS) : "";
  let webSearch = body.web_search === true;
  let searchLimited = false;
  if (webSearch) {
    // Daily web-search quota per plan (tier_config.web_searches_per_day).
    const { data: remaining } = await admin.rpc("web_search_remaining", { p_user: userId });
    if (typeof remaining === "number" && remaining <= 0) {
      webSearch = false;
      searchLimited = true;
    }
  }

  const screenshot = parseImage(body.screenshot);
    // One or several attached files ("attachments"); the single "attachment" field still works.
    const rawAttachments: unknown[] = Array.isArray(body.attachments)
      ? body.attachments
      : body.attachment
        ? [body.attachment]
        : [];
    if (rawAttachments.length > 4) return json(400, { error: "too_many_files", message: "You can attach up to 4 files at once." });
    const attachments: Img[] = [];
    for (const raw of rawAttachments) {
      const parsed = parseImage(raw);
      if (parsed === "invalid" || parsed === null) return json(400, { error: "bad_image" });
      attachments.push(parsed);
    }
    if (screenshot === "invalid") return json(400, { error: "bad_image" });
    if (attachments.reduce((n, a) => n + a.data.length, 0) > 24_000_000) {
      return json(400, { error: "bad_image", message: "Those files are too large to send together." });
    }

    // Pro+ only: bring-your-own model and the advanced reasoning model.
  const reasoning = body.reasoning === true;
  const customModelId = typeof body.custom_model_id === "string" ? body.custom_model_id : null;
  if (reasoning || customModelId) {
    if ((await tierOf(userId)) !== "pro_plus") {
      return json(403, { error: "plan_required", message: "This is a Pro+ feature.", show_pricing: true });
    }
  }
  if (customModelId) {
    const { data: cm } = await admin
      .from("custom_models")
      .select("provider, base_url, model_id, api_key")
      .eq("id", customModelId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!cm) return json(404, { error: "model_not_found", message: "That custom model no longer exists." });
    try {
      const imgs = [...(screenshot ? [screenshot] : []), ...attachments];
      const answer = await askCustom(cm as CustomModel, question, imgs, context);
      return json(200, { answer });
    } catch (err) {
      console.error("custom model failed", err instanceof Error ? err.message : err);
      const m = err instanceof Error ? err.message : "";
      return json(502, {
        error: "provider_unavailable",
        message: m === "pdf_unsupported"
          ? "That model can't read PDFs. Switch back to Clickr AI for this file."
          : m === "bad_base_url"
            ? "That model's endpoint URL isn't allowed (must be public https)."
            : "Your custom model returned an error. Check its model ID and API key in Settings.",
      });
    }
  }

  // Plan-gated inputs, enforced server-side (the app also gates them in the UI).
  // PDF understanding is a Pro feature.
  const needsPaid = attachments.some((a) => a.mime === "application/pdf");
  const multiFile = attachments.length > 1;
  if (needsPaid || multiFile) {
    const { data: sub } = await admin.from("subscriptions").select("tier").eq("user_id", userId).maybeSingle();
    if (!sub || sub.tier === "free") {
      return json(403, {
        error: "plan_required",
        message: needsPaid ? "PDF understanding is available on Pro." : "Attaching several files at once is available on Pro.",
        show_pricing: true,
      });
    }
  }

  // 3. Cost is decided here, from what we actually received (never trust the client's claim).
    const hasAttachment = attachments.length > 0;
    // 3 units for a screenshot or file, plus 1 for each extra file.
    const units = (screenshot !== null || hasAttachment ? 3 : 1) + Math.max(0, attachments.length - 1);

    // 4. Quota gate (atomic, tier resolved server-side).
    const { data: gate, error: gateErr } = await admin.rpc("consume_units", {
        p_user: userId,
        p_units: units,
        p_has_attachment: hasAttachment,
      });
    if (gateErr || !gate) {
      console.error("consume_units failed", gateErr);
      return json(500, { error: "try_again", message: "Something went wrong on our side. Please try again." });
    }
    if (!gate.allowed) {
      return json(429, {
          error: "limit_reached",
          reason: gate.reason,
          retry_after_seconds: gate.retry_after_seconds,
          show_pricing: true,
        });
    }

    // 5. Route to a model (see chooseRoute for the per-plan rules).
    const route = chooseRoute({
      tier: gate.tier,
      degraded: !!gate.degraded,
      escalationAllowed: gate.escalation_allowed !== false,
      primary: gate.primary_model,
      fallback: gate.fallback_model,
      question,
      reasoning,
      webSearch,
      hasPdf: attachments.some((a) => a.mime === "application/pdf"),
    });
    let model = route.model;
    let provider = route.provider;

    // 6. Call the provider; refund the units if it fails.
    try {
      const images = [...(screenshot ? [screenshot] : []), ...attachments];

      if (body.stream === true) {
        let upstream: Response;
        if (provider === "claude") {
          try {
            upstream = await openClaudeStream(model, question, images, context);
          } catch (err) {
            // Claude unavailable (key, quota, outage): quietly use Gemini Pro instead.
            console.error("claude unavailable, falling back", err instanceof Error ? err.message : err);
            provider = "gemini";
            model = PRO_MODEL;
            upstream = await openGeminiStream(model, question, images, context, webSearch, true);
          }
        } else {
          upstream = await openGeminiStream(model, question, images, context, webSearch, !reasoning);
        }
        const streamProvider = provider;
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const send = (c: ReadableStreamDefaultController, obj: unknown) =>
          c.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        const stream = new ReadableStream({
          async start(controller) {
            let buffer = "";
            let gotText = false;
            let searched = false;
            try {
              const reader = upstream.body!.getReader();
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                  if (!line.startsWith("data:")) continue;
                  let chunk;
                  try { chunk = JSON.parse(line.slice(5).trim()); } catch { continue; }
                  let text = "";
                  if (streamProvider === "claude") {
                    if (chunk?.type === "error") throw new ProviderError(0, chunk?.error?.message ?? "claude_error");
                    if (chunk?.type === "content_block_delta" && chunk?.delta?.type === "text_delta") {
                      text = chunk.delta.text ?? "";
                    }
                  } else {
                    const cand = chunk?.candidates?.[0];
                    if ((cand?.groundingMetadata?.webSearchQueries?.length ?? 0) > 0) searched = true;
                    text = (cand?.content?.parts ?? [])
                      .filter((p: { thought?: boolean }) => !p.thought)
                      .map((p: { text?: string }) => p.text ?? "")
                      .join("");
                  }
                  if (text) {
                    gotText = true;
                    send(controller, { delta: text });
                  }
                }
              }
              if (!gotText) throw new ProviderError(0, "empty_response");
              if (searchLimited) {
                send(controller, {
                  delta: "\n\n_You've used today's web searches, so this answer comes from Clickr's built-in knowledge. Your limit resets daily — upgrade for more._",
                });
              }
              if (searched) await admin.rpc("record_web_search", { p_user: userId });
              if (gate.event_id) await admin.from("usage_events").update({ model }).eq("id", gate.event_id);
              send(controller, { done: true });
            } catch (err) {
              console.error("ask stream failed", err instanceof Error ? err.message : err);
              if (!gotText) {
                await admin.rpc("refund_units", {
                  p_user: userId, p_units: units, p_has_attachment: hasAttachment, p_event_id: gate.event_id,
                });
              }
              const detail = Deno.env.get("DEBUG_ERRORS") === "true" && err instanceof Error ? err.message : undefined;
              send(controller, {
                error: "provider_unavailable",
                message: "Something went wrong on our side. Please try again.",
                detail,
              });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
        });
      }

      // The non-streaming path is Gemini-only.
      if (provider === "claude") model = PRO_MODEL;
      const result = await askGemini(model, question, images, context, webSearch);
      let answer = result.text;
      if (result.searched) await admin.rpc("record_web_search", { p_user: userId });
      if (searchLimited) {
        answer += "\n\n_You've used today's web searches, so this answer comes from Clickr's built-in knowledge. Your limit resets daily — upgrade for more._";
      }

      if (gate.event_id) {
        await admin.from("usage_events").update({ model }).eq("id", gate.event_id);
      }
      return json(200, { answer });
    } catch (err) {
      console.error("ask failed", err instanceof Error ? err.message : err);
      await admin.rpc("refund_units", {
          p_user: userId,
          p_units: units,
          p_has_attachment: hasAttachment,
          p_event_id: gate.event_id,
        });

      const busy = err instanceof ProviderError && (err.status === 429 || err.status === 503);
      // While testing, set the DEBUG_ERRORS secret to "true" to see the real cause.
      const detail = Deno.env.get("DEBUG_ERRORS") === "true" && err instanceof Error ? err.message : undefined;
      return json(502, {
          error: "provider_unavailable",
          detail,
          message: busy
          ? "Clickr is a bit busy right now. Please try again in a moment."
          : "Something went wrong on our side. Please try again.",
        });
    }
  });