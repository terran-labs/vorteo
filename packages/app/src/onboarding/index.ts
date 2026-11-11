/**
 * Vorteo keeps owner sign-in and offers an installation-scoped guide afterwards.
 * Upstream's walkthrough stays compiled but hidden under the owner's decision.
 */
export { OnboardingHost } from "./onboarding-host";
export { useOpenOnboarding } from "./use-open-onboarding";

// Owner decision #8363: keep upstream setup hidden. Vorteo uses its authenticated
// installation guide instead; enabling the legacy walkthrough would create two flows.
export const UPSTREAM_SETUP_ENABLED = false;

export { useOpenVorteoSetupGuide } from "./vorteo-guide/host";
