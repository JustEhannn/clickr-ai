import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import NumberFlow from "@number-flow/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FEATURE_LABELS, PLANS, TIER_RANK, minTierFor, planNameFor, type Feature, type Plan, type Tier } from "./tiers";

type Cycle = "monthly" | "annual";

type Props = {
  userId: string | null;
  /** null while the plan is still being fetched. */
  currentTier: Tier | null;
  /** Set when the modal was opened because the user hit a locked feature. */
  feature?: Feature | null;
  onClose: () => void;
  /** Called once the website's checkout has been opened, so the app can watch for the new plan. */
  onPurchaseStarted?: () => void;
};

// Checkout happens on the website: one purchase flow to maintain, with receipts and
// billing management included. The pricing page accepts ?plan=&interval= and jumps
// straight to Stripe (logging the user in first if their browser isn't signed in).
const PRICING_URL = "https://www.clickrai.com/pricing";

function CheckIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function PlanCard({
  plan,
  cycle,
  currentTier,
  onChoose,
  recommended,
}: {
  recommended?: boolean;
  plan: Plan;
  cycle: Cycle;
  currentTier: Tier | null;
  onChoose: (plan: Tier, cycle: Cycle) => void;
}) {
  const known = currentTier !== null;
  const isCurrent = known && plan.tier === currentTier;
  const isIncluded = known && TIER_RANK[plan.tier] < TIER_RANK[currentTier];

  let cta = `Get ${plan.name}`;
  let disabled = false;

  if (!known) {
    cta = "Checking your plan…";
    disabled = true;
  } else if (isCurrent) {
    cta = "Current Plan";
    disabled = true;
  } else if (isIncluded) {
    cta = "Included in your plan";
    disabled = true;
  }

  // "$7.99" -> 7.99, so the number can roll between the monthly and annual price.
  const price = Number((cycle === "annual" ? plan.annual : plan.monthly).replace(/[^0-9.]/g, ""));
  const billing =
    plan.tier === "free" ? "free forever" : cycle === "annual" ? "billed annually" : "billed monthly";

  const classes = [
    "pricing-card",
    plan.popular && !isCurrent ? "pricing-highlight" : "",
    isCurrent ? "pricing-current" : "",
    recommended && !isCurrent ? "pricing-recommended" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <div className="pricing-card-top">
        <div className="pricing-card-name">{plan.name}</div>
        {isCurrent ? (
          <span className="pricing-badge pricing-badge-current">Your plan</span>
        ) : recommended ? (
          <span className="pricing-badge pricing-badge-popular">Unlocks this</span>
        ) : plan.popular ? (
          <span className="pricing-badge pricing-badge-popular">Popular</span>
        ) : null}
      </div>

      <div className="pricing-card-price">
        <NumberFlow
          value={price}
          format={{ style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }}
          transformTiming={{ duration: 500, easing: "ease-out" }}
          willChange
          className="tabular-nums"
        />
        {plan.tier !== "free" && <span> / mo</span>}
      </div>
      <div className="pricing-card-billing">{billing}</div>
      <div className="pricing-card-tagline">{plan.tagline}</div>

      <button
        className="pricing-card-cta"
        type="button"
        disabled={disabled}
        onClick={() => {
          if (plan.tier !== "free") onChoose(plan.tier, cycle);
        }}
      >
        {cta}
      </button>

      <div className="pricing-feature-list">
        {plan.inherits && <div className="pricing-inherits">{plan.inherits}, plus:</div>}
        {plan.headline && (
          <div className="pricing-headline">
            <div className="pricing-headline-title">
              {plan.headline.title} <span className="pricing-headline-tag">Beta</span>
            </div>
            {plan.headline.note && <div className="pricing-headline-note">{plan.headline.note}</div>}
          </div>
        )}
        {plan.features.map((feature) => (
          <div className="pricing-feature-row" key={feature}>
            <span className="pricing-check">
              <CheckIcon />
            </span>
            <span>{feature}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PricingModal({ currentTier, feature, onClose, onPurchaseStarted }: Props) {
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [error, setError] = useState("");

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="pricing-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pricing-modal">
        {/* Drag the whole window by the header (same as the pill). */}
        <div
          className="pricing-modal-header pricing-drag-handle"
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("button, a, input")) return;
            void getCurrentWindow().startDragging();
          }}
        >
          <div>
            <div className="pricing-modal-title">Upgrade Clickr</div>
            <div className="pricing-modal-subtitle">
              {currentTier === null
                ? "Pick the plan that fits how you use it."
                : `You're on ${currentTier === "pro_plus" ? "Pro+" : currentTier === "pro" ? "Pro" : "Free"}. Pick the plan that fits how you use it.`}
            </div>
          </div>
          <button className="pricing-modal-close" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {feature && (
          <div className="pricing-reason">
            <span className="pricing-reason-lock">🔒</span>
            <span>
              <strong>{FEATURE_LABELS[feature]}</strong> is a {planNameFor(feature)} feature.
              {currentTier !== null && TIER_RANK[currentTier] < TIER_RANK[minTierFor(feature)]
                ? ` Upgrade to ${planNameFor(feature)} to unlock it.`
                : ""}
            </span>
          </div>
        )}

        <div className="pricing-cycle-row">
          <span className={`pricing-cycle-label ${cycle === "monthly" ? "active" : ""}`}>Monthly</span>
          <button
            type="button"
            role="switch"
            aria-checked={cycle === "annual"}
            aria-label="Bill annually"
            className={`pricing-switch ${cycle === "annual" ? "on" : ""}`}
            onClick={() => setCycle((c) => (c === "annual" ? "monthly" : "annual"))}
          >
            <span className="pricing-switch-knob" />
          </button>
          <span className={`pricing-cycle-label ${cycle === "annual" ? "active" : ""}`}>Annual</span>
          <span className="pricing-save-chip">Save up to 20%</span>
        </div>

        {error && <div className="shortcut-error" style={{ marginBottom: 10 }}>{error}</div>}

        <div className="pricing-scroll">
          <div className="pricing-cards pricing-cards-two">
            {PLANS.filter((p) => p.tier !== "free").map((plan) => (
              <PlanCard
                key={plan.tier}
                plan={plan}
                cycle={cycle}
                currentTier={currentTier}
                onChoose={(tier, c) => {
                  setError("");
                  openUrl(`${PRICING_URL}?plan=${tier}&interval=${c}`)
                    .then(() => onPurchaseStarted?.())
                    .catch(() => setError("Couldn't open your browser. Go to clickrai.com/pricing to upgrade."));
                }}
                recommended={!!feature && plan.tier === minTierFor(feature)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
