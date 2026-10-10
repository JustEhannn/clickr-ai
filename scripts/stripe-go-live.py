#!/usr/bin/env python3
"""
Switch Clickr's billing from Stripe TEST mode to LIVE mode, in small safe steps.

You run this yourself, so your live secret key never leaves your computer.

    read -s STRIPE_LIVE_SECRET_KEY && export STRIPE_LIVE_SECRET_KEY    # hidden prompt: paste sk_live_..., Enter

    python3 scripts/stripe-go-live.py check             # 1. look only, changes nothing
    python3 scripts/stripe-go-live.py apply             # 2. webhook + billing portal + writes your values file
    #    ...paste the values into Vercel and redeploy the website (the script tells you exactly what)...
    python3 scripts/stripe-go-live.py supabase          # 3. points the app's backend at live Stripe
    python3 scripts/stripe-go-live.py reset-test-data   # 4. clears the fake test subscriptions

Add --dry-run to `apply` to see what it would do without doing it.
"""
import argparse, base64, json, os, stat, subprocess, sys, urllib.error, urllib.parse, urllib.request

SUPABASE_PROJECT = "xoebvsthsmrnuusduzfg"
WEBHOOK_URL = f"https://{SUPABASE_PROJECT}.supabase.co/functions/v1/stripe-webhook"
DEAD_SITE_WEBHOOK = "https://www.clickrai.com/api/stripe/webhook"
ENV_FILE = os.path.expanduser("~/.clickr-stripe-live.env")
EVENTS = ["checkout.session.completed", "customer.subscription.updated",
          "customer.subscription.deleted", "invoice.payment_failed"]

# What each price must be (USD). Annual prices are the per-year totals of $7.99 and $16.99 a month.
EXPECTED = {
    "pro_monthly":  (999,   "month", "Pro, monthly ($9.99)"),
    "pro_annual":   (9588,  "year",  "Pro, annual ($95.88 = $7.99/mo)"),
    "plus_monthly": (1999,  "month", "Pro+, monthly ($19.99)"),
    "plus_annual":  (20388, "year",  "Pro+, annual ($203.88 = $16.99/mo)"),
}

G, R, Y, B, X = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[0m"
ok = lambda m: print(f"  {G}✓{X} {m}")
bad = lambda m: print(f"  {R}✗{X} {m}")
warn = lambda m: print(f"  {Y}!{X} {m}")


def die(msg):
    print(f"\n{R}{msg}{X}")
    sys.exit(1)


class Stripe:
    def __init__(self, key):
        self.auth = "Basic " + base64.b64encode((key + ":").encode()).decode()

    def call(self, method, path, data=None):
        body = urllib.parse.urlencode(data, doseq=True).encode() if data else None
        req = urllib.request.Request("https://api.stripe.com/v1/" + path, data=body, method=method,
                                     headers={"Authorization": self.auth})
        try:
            return json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as e:
            detail = json.loads(e.read().decode() or "{}").get("error", {}).get("message", e.reason)
            die(f"Stripe said no ({e.code}): {detail}")

    get = lambda self, path: self.call("GET", path)


def load_key(allow_test=False):
    key = os.environ.get("STRIPE_LIVE_SECRET_KEY", "").strip()
    if not key:
        die("No key found. Run this first (it hides what you type), then try again:\n\n"
            "    read -s STRIPE_LIVE_SECRET_KEY && export STRIPE_LIVE_SECRET_KEY")
    if key.startswith(("sk_test", "rk_test")):
        if not allow_test:
            die("That is a TEST key (sk_test_...). This script is for your LIVE key (sk_live_...).")
        print(f"{Y}Using a TEST key (--allow-test): read-only rehearsal.{X}")
    elif not key.startswith(("sk_live", "rk_live")):
        die("That doesn't look like a Stripe secret key (it should start with sk_live_).")
    return key


def find_prices(stripe, overrides):
    """Match your live prices by amount + billing period."""
    found, problems = {}, False
    prices = stripe.get("prices?active=true&type=recurring&limit=100&expand[]=data.product")["data"]
    for name, (amount, interval, label) in EXPECTED.items():
        if name in overrides:
            p = stripe.get(f"prices/{overrides[name]}?expand[]=product")
            matches = [p]
        else:
            matches = [p for p in prices
                       if p["unit_amount"] == amount and p["currency"] == "usd"
                       and p["recurring"]["interval"] == interval and p["recurring"]["interval_count"] == 1]
        if len(matches) == 1:
            p = matches[0]
            ok(f"{label}: {p['id']}  (product “{p['product']['name']}”)")
            found[name] = p["id"]
        elif not matches:
            bad(f"{label}: no active live price with that amount. Create it in Stripe, or pass --price {name}=price_...")
            problems = True
        else:
            bad(f"{label}: {len(matches)} matching prices {[m['id'] for m in matches]}. "
                f"Pick one with --price {name}=price_...")
            problems = True
    return found, problems


def check(stripe, args, quiet_next=False):
    print(f"\n{B}1. Your Stripe account{X}")
    acct = stripe.get("account")
    name = (acct.get("business_profile") or {}).get("name") or acct.get("settings", {}).get("dashboard", {}).get("display_name")
    ok(f"Account: {name or acct['id']} ({acct.get('country')})")
    problems = False
    if acct.get("charges_enabled"):
        ok("Can accept live payments")
    else:
        bad("Live payments are NOT enabled yet. Finish Stripe's account activation (business details + bank account), then rerun.")
        problems = True
    if acct.get("payouts_enabled"):
        ok("Payouts to your bank are enabled")
    else:
        warn("Payouts aren't enabled yet (add a bank account in Stripe) — you can take payments but not receive them.")

    print(f"\n{B}2. Your live prices{X}")
    prices, p_problems = find_prices(stripe, args.price_map)
    problems = problems or p_problems

    print(f"\n{B}3. Webhook endpoints{X}")
    endpoints = stripe.get("webhook_endpoints?limit=50")["data"]
    mine = [e for e in endpoints if e["url"] == WEBHOOK_URL]
    dead = [e for e in endpoints if e["url"] == DEAD_SITE_WEBHOOK]
    ok(f"{len(endpoints)} endpoint(s) in live mode")
    if mine:
        warn("An endpoint for the app already exists. Its signing secret can't be re-read, so `apply` will replace it with a fresh one.")
    if dead:
        warn("The old website endpoint (404) exists; `apply` will remove it.")

    print(f"\n{B}4. Customer portal (the “Manage subscription” page){X}")
    portal = stripe.get("billing_portal/configurations?limit=5")["data"]
    if portal:
        ok("A live portal configuration exists")
    else:
        warn("None in live mode yet — `apply` will create a sensible one (cancel, update card, invoices).")

    if problems:
        die("Fix the ✗ items above, then run `check` again.")
    if not quiet_next:
        print(f"\n{G}{B}All good.{X} Next: python3 scripts/stripe-go-live.py apply")
    return prices, mine, dead, portal


def apply(stripe, key, args):
    prices, mine, dead, portal = check(stripe, args, quiet_next=True)
    print(f"\n{B}Applying{X}{'  (dry run: nothing will change)' if args.dry_run else ''}")

    secret = "(new signing secret)"
    for e in mine:
        print(f"  - remove old app endpoint {e['id']}")
        if not args.dry_run:
            stripe.call("DELETE", f"webhook_endpoints/{e['id']}")
    for e in dead:
        print(f"  - remove dead website endpoint {e['id']}")
        if not args.dry_run:
            stripe.call("DELETE", f"webhook_endpoints/{e['id']}")
    print(f"  - create endpoint → {WEBHOOK_URL}")
    if not args.dry_run:
        ep = stripe.call("POST", "webhook_endpoints", {
            "url": WEBHOOK_URL, "description": "Clickr plan sync (Supabase stripe-webhook)",
            "enabled_events[]": EVENTS})
        secret = ep["secret"]

    if not portal:
        print("  - create the customer portal configuration")
        if not args.dry_run:
            stripe.call("POST", "billing_portal/configurations", {
                "business_profile[headline]": "Manage your Clickr subscription",
                "default_return_url": "https://www.clickrai.com/account",
                "features[invoice_history][enabled]": "true",
                "features[payment_method_update][enabled]": "true",
                "features[customer_update][enabled]": "true",
                "features[customer_update][allowed_updates][]": ["email", "name"],
                "features[subscription_cancel][enabled]": "true",
                "features[subscription_cancel][mode]": "at_period_end",
            })

    values = {
        "STRIPE_SECRET_KEY": key,
        "STRIPE_WEBHOOK_SECRET": secret,
        "STRIPE_PRICE_PRO": prices["pro_monthly"],
        "STRIPE_PRICE_PRO_ANNUAL": prices["pro_annual"],
        "STRIPE_PRICE_PRO_PLUS": prices["plus_monthly"],
        "STRIPE_PRICE_PRO_PLUS_ANNUAL": prices["plus_annual"],
    }
    if args.dry_run:
        print(f"\n{Y}Dry run finished. Nothing was changed.{X}")
        return

    with open(ENV_FILE, "w") as f:
        f.write("# Clickr LIVE Stripe values. Secret: never commit or share this file.\n")
        for k, v in values.items():
            f.write(f"{k}={v}\n")
    os.chmod(ENV_FILE, stat.S_IRUSR | stat.S_IWUSR)

    print(f"""
{G}{B}Done.{X} Your live values are saved (only you can read it) at:
    {ENV_FILE}

{B}Next, update the website on Vercel{X} (Project → Settings → Environment Variables, "Production"):
    STRIPE_SECRET_KEY                 = (the sk_live_ key)
    STRIPE_PRICE_PRO_MONTHLY          = {prices['pro_monthly']}
    STRIPE_PRICE_PRO_ANNUAL           = {prices['pro_annual']}
    STRIPE_PRICE_PRO_PLUS_MONTHLY     = {prices['plus_monthly']}
    STRIPE_PRICE_PRO_PLUS_ANNUAL      = {prices['plus_annual']}
Then press Redeploy on the latest production deployment.

{B}Then run:{X}  python3 scripts/stripe-go-live.py supabase
""")


def read_env_file():
    if not os.path.exists(ENV_FILE):
        die(f"{ENV_FILE} not found. Run `apply` first.")
    out = {}
    for line in open(ENV_FILE):
        if "=" in line and not line.startswith("#"):
            k, v = line.strip().split("=", 1)
            out[k] = v
    return out


def supabase(args):
    vals = read_env_file()
    if not vals.get("STRIPE_SECRET_KEY", "").startswith(("sk_live", "rk_live")):
        die("The saved values aren't live ones. Run `apply` first.")
    print(f"\n{B}This points the app's backend (Supabase) at LIVE Stripe.{X}")
    print("From now on, payments through the app and website are real money.")
    print("Have you already updated the website's Vercel variables and redeployed?")
    if input("Type yes to continue: ").strip().lower() != "yes":
        die("Stopped. Nothing changed.")
    pairs = [f"{k}={v}" for k, v in vals.items()]
    r = subprocess.run(["npx", "supabase", "secrets", "set", *pairs, "--project-ref", SUPABASE_PROJECT],
                       capture_output=True, text=True)
    if "Finished" not in (r.stdout + r.stderr):
        die("Setting the Supabase secrets failed:\n" + (r.stderr or r.stdout)[-600:])
    ok("Supabase secrets updated (Edge Functions pick them up within a minute)")
    print(f"\n{G}{B}Live billing is on.{X} Next: python3 scripts/stripe-go-live.py reset-test-data, then buy a plan with a real card.")


def sql(query):
    r = subprocess.run(["npx", "supabase", "db", "query", "--linked", query], capture_output=True, text=True)
    return r.stdout + r.stderr


def reset_test_data(args):
    print(f"\n{B}Clears the FAKE subscriptions and Stripe customers created while testing.{X}")
    print("Live Stripe has never seen those customer IDs, so leaving them would break checkout for those accounts.\n")
    print(sql("select u.email, s.tier, s.stripe_subscription_id is not null as has_sub, p.stripe_customer_id is not null as has_customer "
              "from auth.users u left join subscriptions s on s.user_id=u.id left join profiles p on p.id=u.id "
              "where s.stripe_subscription_id is not null or p.stripe_customer_id is not null"))
    print("Those accounts go back to Free. This only touches billing fields, not accounts, chats or memories.")
    if input("Type yes to reset them: ").strip().lower() != "yes":
        die("Stopped. Nothing changed.")
    sql("update subscriptions set tier='free', status='active', billing_cycle=null, stripe_subscription_id=null, "
        "current_period_end=null, cancel_at_period_end=false, updated_at=now() where stripe_subscription_id is not null; "
        "update profiles set stripe_customer_id=null where stripe_customer_id is not null;")
    ok("Test billing data cleared")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["check", "apply", "supabase", "reset-test-data"])
    ap.add_argument("--dry-run", action="store_true", help="with apply: show what would happen, change nothing")
    ap.add_argument("--allow-test", action="store_true", help="rehearse `check` with a test key")
    ap.add_argument("--price", action="append", default=[], metavar="NAME=price_...",
                    help="pick a price by hand (names: " + ", ".join(EXPECTED) + ")")
    args = ap.parse_args()
    args.price_map = dict(p.split("=", 1) for p in args.price)

    if args.command in ("check", "apply"):
        if args.command == "apply" and args.allow_test:
            die("--allow-test only works with `check`.")
        key = load_key(allow_test=args.allow_test and args.command == "check")
        stripe = Stripe(key)
        if args.command == "check":
            check(stripe, args)
        else:
            apply(stripe, key, args)
    elif args.command == "supabase":
        supabase(args)
    else:
        reset_test_data(args)


if __name__ == "__main__":
    main()
