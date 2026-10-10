// supabase/functions/stripe-webhook/index.ts
// Receives Stripe events and updates public.subscriptions accordingly.
// Identical handling regardless of where checkout was started (app or website),
// per Section 6 of the billing plan.
//
// IMPORTANT: this function must have "Enforce JWT Verification" turned OFF
// in Supabase — Stripe authenticates via its own signature header, not a
// Supabase JWT. Signature verification below is what actually secures it.
//
// Secrets required: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_PRO, STRIPE_PRICE_PRO_PLUS.
//
// After deploying, create the webhook endpoint in the Stripe dashboard
// pointing at this function's URL, subscribed to: checkout.session.completed,
// customer.subscription.updated, customer.subscription.deleted,
// invoice.payment_failed. Copy the signing secret it gives you into
// STRIPE_WEBHOOK_SECRET.

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.5.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2025-03-31.basil",
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Monthly AND annual price IDs map to the same tiers. Unset secrets are skipped
// so an empty string never matches anything.
const PRICE_TO_TIER: Record<string, string> = {};
for (const [envName, tier] of [
  ["STRIPE_PRICE_PRO", "pro"],
  ["STRIPE_PRICE_PRO_PLUS", "pro_plus"],
  ["STRIPE_PRICE_PRO_ANNUAL", "pro"],
  ["STRIPE_PRICE_PRO_PLUS_ANNUAL", "pro_plus"],
] as const) {
  const id = Deno.env.get(envName);
  if (id) PRICE_TO_TIER[id] = tier;
}

function tierForPriceId(priceId: string | undefined): string {
  return (priceId && PRICE_TO_TIER[priceId]) || "free";
}

async function upsertSubscriptionFromStripe(userId: string, sub: Stripe.Subscription) {
  const priceId = sub.items.data[0]?.price?.id;
  // Newer Stripe API versions moved the period end from the subscription onto its items.
  const periodEnd: number | undefined =
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    (sub.items.data[0] as unknown as { current_period_end?: number })?.current_period_end;
  await admin
    .from("subscriptions")
    .update({
      tier: tierForPriceId(priceId),
      status: sub.status,
      billing_cycle: sub.items.data[0]?.price?.recurring?.interval === "year" ? "annual" : "monthly",
      stripe_subscription_id: sub.id,
      current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}

async function findUserIdByCustomer(customerId: string): Promise<string | null> {
  const { data } = await admin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.id ?? null;
}

// ---- Purchase confirmation email (Resend) -----------------------------------
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_ADDRESS = "Clickr AI <hello@ClickrAI.com>";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function sendPurchaseEmail(opts: {
  to: string | null | undefined;
  sub: Stripe.Subscription;
  amountTotal: number | null;
  currency: string | null;
}) {
  if (!RESEND_API_KEY || !opts.to) return;

  const price = opts.sub.items.data[0]?.price;
  const tier = tierForPriceId(price?.id);
  const plan = tier === "pro_plus" ? "Pro+" : tier === "pro" ? "Pro" : "Clickr";
  const interval = price?.recurring?.interval === "year" ? "Annual" : "Monthly";
  const amount =
    opts.amountTotal != null
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: (opts.currency ?? "usd").toUpperCase() }).format(opts.amountTotal / 100)
      : null;
  const renews = opts.sub.current_period_end
    ? new Date(opts.sub.current_period_end * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;

  const row = (label: string, value: string | null) =>
    value
      ? `<tr><td style="padding:8px 0;color:#8b93a7;font-size:14px">${esc(label)}</td><td style="padding:8px 0;text-align:right;color:#ffffff;font-size:14px;font-weight:600">${esc(value)}</td></tr>`
      : "";

  const html = `<!doctype html><html><body style="margin:0;background:#05060A;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#0B0D13;border:1px solid #1d212b;border-radius:16px">
    <tr><td style="padding:32px 32px 8px;text-align:center">
      <div style="font-size:22px;font-weight:700;color:#ffffff">You're all set 🎉</div>
      <div style="margin-top:8px;font-size:15px;line-height:1.5;color:#b6bdcc">Thanks for upgrading. Your <strong style="color:#9DC0FF">Clickr ${esc(plan)}</strong> plan is active — open Clickr and it will unlock within a few moments.</div>
    </td></tr>
    <tr><td style="padding:16px 32px">
      <table role="presentation" width="100%" style="border-top:1px solid #1d212b;border-bottom:1px solid #1d212b">
        ${row("Plan", `${plan} · ${interval}`)}
        ${row("Amount paid", amount)}
        ${row("Next renewal", renews)}
      </table>
    </td></tr>
    <tr><td style="padding:8px 32px 32px;text-align:center">
      <a href="https://www.clickrai.com/account#billing" style="display:inline-block;background:#1F61EF;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:10px">Manage billing</a>
      <div style="margin-top:20px;font-size:12px;line-height:1.5;color:#6b7385">A receipt from Stripe is on its way separately. Questions? Just reply to this email.</div>
    </td></tr>
  </table></body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      reply_to: "clickraisupport@gmail.com",
      to: [opts.to],
      subject: `Your Clickr ${plan} plan is active`,
      html,
    }),
  });
  if (!res.ok) console.error("purchase email failed", res.status, (await res.text()).slice(0, 300));
}

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  const body = await req.text();

  if (!signature) return new Response("Missing signature.", { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature verification failed", err);
    return new Response("Invalid signature.", { status: 400 });
  }

  // Idempotency: stripe_events.id is the primary key, so a duplicate delivery
  // fails this insert and we know to skip reprocessing.
  const { error: dupeCheck } = await admin
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });

  if (dupeCheck) {
    if (dupeCheck.code === "23505") {
      return new Response("already processed", { status: 200 });
    }
    console.error("stripe_events insert failed", dupeCheck);
    return new Response("db error", { status: 500 }); // triggers a Stripe retry
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ?? (session.metadata?.user_id as string | undefined);
        if (!userId || !session.customer || !session.subscription) break;

        await admin.from("profiles").update({ stripe_customer_id: session.customer as string }).eq("id", userId);

        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        await upsertSubscriptionFromStripe(userId, sub);

        // Confirmation email. Never let an email problem undo or delay the plan update.
        await sendPurchaseEmail({
          to: session.customer_details?.email ?? session.customer_email,
          sub,
          amountTotal: session.amount_total,
          currency: session.currency,
        }).catch((e) => console.error("purchase email error", e));
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = await findUserIdByCustomer(sub.customer as string);
        if (!userId) break;

        if (event.type === "customer.subscription.deleted") {
          await admin
            .from("subscriptions")
            .update({ tier: "free", status: "canceled", updated_at: new Date().toISOString() })
            .eq("user_id", userId);
        } else {
          await upsertSubscriptionFromStripe(userId, sub);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const userId = await findUserIdByCustomer(invoice.customer as string);
        if (!userId) break;

        await admin
          .from("subscriptions")
          .update({ status: "past_due", updated_at: new Date().toISOString() })
          .eq("user_id", userId);
        break;
      }

      default:
        // Unhandled event types are fine to ignore.
        break;
    }
  } catch (err) {
    console.error(`Failed handling ${event.type}`, err);
    return new Response("handler error", { status: 500 }); // triggers a Stripe retry
  }

  return new Response("ok", { status: 200 });
});