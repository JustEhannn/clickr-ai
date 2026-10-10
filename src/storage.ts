/**
 * "Has this account seen the guide?" is remembered per account, not per Mac, so a
 * new account signing in on a machine that already ran the tour still gets it.
 */
export const onboardingKey = (userId: string) => `clickr-onboarding-complete:${userId}`;

/** Whether this account has read and accepted the Agent Mode beta notice. */
export const agentBetaKey = (userId: string) => `clickr-agent-beta-ack:${userId}`;
