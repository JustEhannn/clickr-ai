// supabase/functions/app-auth-exchange/index.ts
// Called by the Clickr DESKTOP APP with the one-time code from the deep link plus the
// PKCE verifier it kept in memory. Returns a real session for the app.
// No JWT is required (the app has none yet): the code (256 random bits, single use,
// 2-minute lifetime) AND the verifier together are the proof.
//
// Request (POST): { code: string, verifier: string }
// Response: { access_token, refresh_token, user: { id, email } }
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const anon = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  let body: { code?: string; verifier?: string };
  try { body = await req.json(); } catch { return reply(400, { error: "bad_request" }); }
  if (!body.code || !body.verifier || body.code.length > 100 || body.verifier.length > 200) {
    return reply(400, { error: "bad_request" });
  }

  // Deleting returns the row exactly once, so a code can never be used twice.
  const { data: rows } = await admin.from("app_auth_codes").delete().eq("code_hash", hex(await sha256(body.code))).select();
  const row = rows?.[0];
  if (!row) return reply(400, { error: "invalid_code", message: "That sign-in link has expired. Please try again." });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return reply(400, { error: "expired", message: "That sign-in link has expired. Please try again." });
  }
  if (!safeEqual(b64url(await sha256(body.verifier)), row.challenge)) {
    return reply(400, { error: "bad_verifier", message: "Sign-in didn't match this app. Please try again." });
  }

  const { data, error } = await anon.auth.verifyOtp({ token_hash: row.token_hash, type: "magiclink" });
  if (error || !data.session || !data.user) {
    console.error("verifyOtp failed", error?.message);
    return reply(500, { error: "try_again", message: "Couldn't finish signing in. Please try again." });
  }
  return reply(200, {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: { id: data.user.id, email: data.user.email },
  });
});
