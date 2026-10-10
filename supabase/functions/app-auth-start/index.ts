// supabase/functions/app-auth-start/index.ts
// Called by the Clickr WEBSITE after the user has signed in there (password or Google).
// Creates a one-time code tied to the desktop app's PKCE challenge, so the browser
// can hand the sign-in to the app via clickr://auth-callback?handoff=<code>.
//
// Request (POST, Authorization: Bearer <user access token>): { challenge: string }
// Response: { code: string }
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const ALLOWED_ORIGINS = new Set([
  "https://www.clickrai.com",
  "https://clickrai.com",
  "https://getclickr.vercel.app",
  "http://localhost:3000",
]);

const corsHeaders = (req: Request) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(req.headers.get("origin") ?? "")
    ? req.headers.get("origin")!
    : "https://www.clickrai.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const reply = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const sha256Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "method_not_allowed" });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user?.email) return reply(req, 401, { error: "not_signed_in" });

  let body: { challenge?: string };
  try { body = await req.json(); } catch { return reply(req, 400, { error: "bad_request" }); }
  // A base64url SHA-256 is always 43 characters.
  if (!body.challenge || !/^[A-Za-z0-9_-]{43}$/.test(body.challenge)) return reply(req, 400, { error: "bad_challenge" });

  // A fresh single-use OTP for this user; it becomes the app's own session on exchange.
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    console.error("generateLink failed", linkErr);
    return reply(req, 500, { error: "try_again", message: "Couldn't connect to the app. Please try again." });
  }

  const code = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await admin.from("app_auth_codes").delete().lt("expires_at", new Date().toISOString());
  const { error: insErr } = await admin.from("app_auth_codes").insert({
    code_hash: await sha256Hex(code),
    challenge: body.challenge,
    token_hash: tokenHash,
    user_id: user.id,
    expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
  });
  if (insErr) {
    console.error("insert failed", insErr);
    return reply(req, 500, { error: "try_again", message: "Couldn't connect to the app. Please try again." });
  }
  return reply(req, 200, { code });
});
