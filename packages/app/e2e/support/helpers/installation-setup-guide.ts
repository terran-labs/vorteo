import type { BrowserContext } from "@playwright/test";

export interface InstallationGuideEnvironment {
  origin: string;
  isTopLevel: boolean;
  storage: Pick<Storage, "getItem" | "setItem">;
}

interface InstallationGuideSeed {
  origin: string;
  key: string;
}

/** Keep self-contained: the browser registration serializes this function. */
export function seedInstallationSetupGuide(
  environment: InstallationGuideEnvironment,
  seed: InstallationGuideSeed,
): void {
  if (!environment.isTopLevel) return;
  if (environment.origin !== seed.origin) return;
  if (environment.storage.getItem(seed.key) !== null) return;
  environment.storage.setItem(
    seed.key,
    JSON.stringify({ disposition: "completed", updatedAt: new Date().toISOString() }),
  );
}

/** Register on an unnavigated context; this cannot dismiss an already loaded guide. */
export async function completeInstallationSetupGuide(
  context: Pick<BrowserContext, "addInitScript">,
  installation: { installationId: string; origin: string },
): Promise<void> {
  if (!installation.installationId.trim()) {
    throw new TypeError("Installation setup requires a nonempty installation identity");
  }
  const expectedOrigin = new URL(installation.origin).origin;
  const storageKey = `@vorteo:setup:v1:${encodeURIComponent(installation.installationId)}`;

  const seed = JSON.stringify({ origin: expectedOrigin, key: storageKey });
  // The getter defers storage access until the origin and frame guards pass.
  await context.addInitScript(`(${seedInstallationSetupGuide.toString()})({
    origin: window.location.origin,
    isTopLevel: window === window.top,
    get storage() { return window.localStorage; }
  }, ${seed});`);
}
