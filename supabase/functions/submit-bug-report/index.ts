// supabase/functions/submit-bug-report/index.ts
// Saves a bug report from the Clickr app and emails the owner.
// The reporter's identity (user id + email) comes from their verified token, never from
// the request body, so reports can't be spoofed.
//
// Request (POST, Authorization: Bearer <user access token>):
//   { message: string, context?: object }
// Optional secret: ADMIN_EMAIL (where the notification goes; default below).
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "clickraisupport@gmail.com";
const FROM_ADDRESS = "Clickr AI <hello@ClickrAI.com>";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const esc = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) return reply(401, { error: "not_signed_in" });

  let body: { message?: unknown; context?: unknown };
  try { body = await req.json(); } catch { return reply(400, { error: "bad_request" }); }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 3 || message.length > 4000) {
    return reply(400, { error: "bad_message", message: "Please describe what went wrong (a sentence or two is plenty)." });
  }
  let context: Record<string, unknown> = {};
  if (body.context && typeof body.context === "object" && !Array.isArray(body.context)) {
    const json = JSON.stringify(body.context);
    context = json.length <= 8000 ? (body.context as Record<string, unknown>) : { note: "context was too large and was dropped" };
  }

  // Basic abuse guard: 8 reports an hour per account.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("bug_reports").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", since);
  if ((count ?? 0) >= 8) {
    return reply(429, { error: "slow_down", message: "You've sent a few reports already — we'll look into them. Try again a bit later." });
  }

  const { data: row, error } = await admin
    .from("bug_reports")
    .insert({ user_id: user.id, email: user.email ?? null, message, context })
    .select("id")
    .single();
  if (error) {
    console.error("bug insert failed", error);
    return reply(500, { error: "try_again", message: "Couldn't send your report. Please try again." });
  }

  // Heads-up email to the owner. A failure here never loses the report (it is already saved).
  if (RESEND_API_KEY) {
    const ctxRows = Object.entries(context)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#8b93a7;font-size:13px;vertical-align:top">${esc(k)}</td><td style="padding:3px 0;color:#e6e9f0;font-size:13px;white-space:pre-wrap">${esc(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`)
      .join("");
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#05060A;color:#fff;padding:24px">
      <div style="font-size:12px;color:#9DC0FF;text-transform:uppercase;letter-spacing:.06em">New bug report #${row.id}</div>
      <div style="margin:6px 0 14px;font-size:15px;color:#b6bdcc">From <strong style="color:#fff">${esc(user.email ?? "unknown")}</strong></div>
      <div style="white-space:pre-wrap;font-size:15px;line-height:1.5;background:#0B0D13;border:1px solid #1d212b;border-radius:10px;padding:14px">${esc(message)}</div>
      <table style="margin-top:14px">${ctxRows}</table>
      <div style="margin-top:18px"><a href="https://www.clickrai.com/admin/bugs" style="color:#9DC0FF">Open in admin</a></div></div>`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [ADMIN_EMAIL],
        reply_to: user.email ?? undefined,
        subject: `Clickr bug #${row.id}: ${message.slice(0, 60).replace(/\s+/g, " ")}`,
        html,
      }),
    }).catch((e) => console.error("bug email failed", e));
  }

  return reply(200, { ok: true, id: row.id });
});
