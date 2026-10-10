# Launch checklist

Everything below is something only you can do (accounts, certificates, money, decisions), plus a
test pass. Code-wise the Mac app is release-ready. Tick things off in order.

## 1. Apple Developer ID — signing and notarization (the big one)
Without this, every download shows "Clickr can't be opened because it is from an unidentified
developer", people must right-click → Open, and each update re-asks for Keychain access.

1. Join the **Apple Developer Program** ($99/year): https://developer.apple.com/programs/
2. In Xcode → Settings → Accounts → Manage Certificates, create a **Developer ID Application**
   certificate. (Or developer.apple.com → Certificates.)
3. Find its exact name:

   ```bash
   security find-identity -v -p codesigning
   ```

   It looks like `Developer ID Application: Your Name (ABCDE12345)`.
4. Create an **app-specific password** at https://appleid.apple.com → Sign-In and Security.
5. Put these in your terminal profile (or a file you `source` before releasing):

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
   export APPLE_ID="you@example.com"
   export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"      # the app-specific password
   export APPLE_TEAM_ID="ABCDE12345"
   ```

6. Release as normal (`scripts/release.sh "..."`). The script notices `APPLE_SIGNING_IDENTITY`,
   signs with it and has Apple notarize the build (adds a few minutes). Nothing else changes.

## 2. Stripe: test mode → live mode
Everything so far ran in Stripe's **test mode** (fake cards). To take real money:

1. In Stripe, switch to **Live mode** and create the same 4 prices (Pro and Pro+, monthly and annual).
2. Create a **live** webhook endpoint → `https://xoebvsthsmrnuusduzfg.supabase.co/functions/v1/stripe-webhook`
   with events `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`. Copy its signing secret.
3. Update the Supabase secrets with the **live** values:

   ```bash
   npx supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... STRIPE_PRICE_PRO=price_... STRIPE_PRICE_PRO_ANNUAL=price_... STRIPE_PRICE_PRO_PLUS=price_... STRIPE_PRICE_PRO_PLUS_ANNUAL=price_... --project-ref xoebvsthsmrnuusduzfg
   ```

4. Update the same keys/prices in the **website's** environment variables on Vercel (and redeploy).
5. Turn on the **Customer Portal** (Stripe → Settings → Billing → Customer portal) so "Manage
   subscription" works.
6. Delete the old dead endpoint `https://www.clickrai.com/api/stripe/webhook` (it returns 404) in
   Stripe's webhook list.
7. Buy a plan yourself with a real card, check the app unlocks, then refund it from Stripe.

## 3. Email
- Make sure **clickraisupport@gmail.com** is a real inbox (the app, website and bug-report replies use it).
- Supabase → Authentication → SMTP: use your Resend SMTP so sign-up, password-reset and
  confirmation emails aren't capped at a few an hour.
- Check the welcome and purchase emails arrive (not in spam) from a fresh account.

## 4. Sign-in
- Google Cloud Console → OAuth consent screen: publish it (status "In production"), add your
  privacy policy and terms links, so people aren't shown a "unverified app" warning.
- Supabase → Authentication → URL Configuration: make sure `https://www.clickrai.com/auth/callback`
  and `clickr://auth-callback` are in the allowed redirect URLs.

## 5. Optional but worth doing
- **Claude for Pro+:** `npx supabase secrets set ANTHROPIC_API_KEY=... --project-ref xoebvsthsmrnuusduzfg`
  (until then Pro+ uses Gemini only). Then put the claim back on the site.
- **Billing alerts:** set a budget alert on your Google AI (and Anthropic) accounts.
- **Backups:** Supabase → Database → Backups (daily backups need the Pro plan).
- **Agent Mode kill switch** if something goes wrong in the wild:

  ```sql
  update app_config set value = 'false'::jsonb where key = 'agent_enabled';
  ```

## 6. Publish
1. `DRY_RUN=1 scripts/release.sh "test"` → install the DMG it builds on your own Mac and use it.
2. `scripts/release.sh "Clickr 0.1.0"` → uploads the DMG and update feed.
3. Commit and push the website (the Download button, new pricing text, privacy page).
4. Check `https://www.clickrai.com/download/mac` downloads the DMG.

## 7. Test pass on a clean Mac (or a new macOS user account)
- [ ] Download from the site → open DMG → drag to Applications → open.
- [ ] Sign up with email, then again with Google (welcome email arrives).
- [ ] Screen Recording permission screen works; restart; chat appears; guide shows.
- [ ] Ask a question, a screen question, a web question; Stop works; copy works.
- [ ] Free limit message appears (use up the daily units, or lower the cap temporarily).
- [ ] Upgrade flow: pick a plan → browser opens → pay → app unlocks by itself.
- [ ] Pro: history, memory, multi-file, hotkeys. Pro+: Agent Mode (Accessibility step), custom model.
- [ ] Settings: report a bug (arrives in /admin/bugs and your email), open at login, check for updates.
- [ ] Sign out and sign in as a different account: no old chats visible.
- [ ] An Intel Mac, if you have one (the build is universal but only tested on Apple Silicon).

## 8. After launch
- Watch `/admin/bugs` and `select * from agent_daily_stats;` in the SQL editor.
- Watch your AI spend against what users pay.
- Ship fixes with `scripts/release.sh`; pull a bad one with `scripts/rollback.sh` (see RELEASING.md).
