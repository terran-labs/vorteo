import { PrimaryConnectionUnavailableError } from "@/execution-installation/primary-connection-error";
import type { InstallationSettingsSnapshot } from "@getpaseo/protocol/installation-settings";
import type { PrimaryConnectionChoice } from "@/execution-installation/primary-connection";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderUsage } from "@/provider-usage/types";
import { createOnboardingModel, type OnboardingModel } from "../internal/model";

export interface GuideRecord {
  disposition: "skipped" | "completed";
  updatedAt: string;
}

export interface GuideStorage {
  read(installationId: string): Promise<GuideRecord | null>;
  write(installationId: string, record: GuideRecord): Promise<void>;
}

export interface GuideHost {
  installationId: string;
  serverId: string;
  ownerAuthenticated: boolean;
  isConnected: boolean;
  hasHydratedWorkspaces: boolean;
  hasUserProjects: boolean;
  supportsPrimaryConnection: boolean;
}

export interface GuideSnapshotRefresh {
  supportsSnapshot: boolean;
  refresh(): Promise<void>;
}

/** Manual retries must obey the same capability boundary as automatic snapshot reads. */
export function refreshGuideProviderSnapshot(snapshot: GuideSnapshotRefresh): Promise<void> {
  if (!snapshot.supportsSnapshot) {
    return Promise.reject(new Error("Provider snapshots are not supported by this host"));
  }
  return snapshot.refresh();
}

export interface GuidePrimaryConnectionRequest {
  runtimeProviderId: string;
  serverId: string;
}

/** A runtime account binding is not the shared definition ID accepted by Settings. */
export function guidePrimaryConnectionChoice(
  snapshot: InstallationSettingsSnapshot,
  request: GuidePrimaryConnectionRequest,
): PrimaryConnectionChoice | null {
  const definition = snapshot.settings?.providerDefinitions?.find(
    (item) =>
      item.bindings[request.serverId] === request.runtimeProviderId &&
      item.policy.enabled !== false &&
      !item.removed,
  );
  return definition ? { providerId: definition.id } : null;
}

/** A ready catalog proves detection, not sign-in for every provider. */
export function guideProviderSignedIn(
  entry: ProviderSnapshotEntry,
  usage: readonly ProviderUsage[],
) {
  const account = usage.find((item) => item.providerId === entry.provider);
  if (account?.authRecovery || account?.credentialsMissing || account?.refreshError) return false;
  if (account?.status === "available") return true;
  // Claude's availability check runs requireClaudeAuthentication before publishing ready.
  return entry.provider === "claude" && entry.status === "ready";
}

export type VorteoGuideModel = Omit<OnboardingModel, "applySetupHost" | "reopen"> & {
  readonly primaryRuntimeProviderId: string | null;
  recordPrimaryConnection(
    runtimeProviderId: string,
    visit: number,
  ): Promise<"saved" | "local" | "stale">;
  applyGate(host: GuideHost | null): void;
  reopen(host: GuideHost): void;
  skip(): Promise<void>;
  pause(): Promise<void>;
};

export function createVorteoGuide(input: {
  installationId: string;
  storage: GuideStorage;
  savePrimaryConnection(request: GuidePrimaryConnectionRequest): Promise<unknown>;
}): VorteoGuideModel {
  let activeHost: GuideHost | null = null;
  let primaryRuntimeProviderId: string | null = null;
  let disposition: GuideRecord["disposition"] = "completed";
  let remember = true;
  const options = { includePhoneStep: true };
  // Reuse upstream's navigation and visit tokens. Completion here records the guide only,
  // never whether credentials have reached all environments or an account is usable.
  const model = createOnboardingModel({
    storage: {
      isCompleted: async () => (await input.storage.read(input.installationId)) !== null,
      markCompleted: () =>
        remember
          ? input.storage.write(input.installationId, {
              disposition,
              updatedAt: new Date().toISOString(),
            })
          : Promise.resolve(),
    },
  });
  const canEnter = (host: GuideHost | null): host is GuideHost =>
    Boolean(
      host &&
      host.installationId === input.installationId &&
      host.ownerAuthenticated &&
      host.isConnected &&
      host.hasHydratedWorkspaces,
    );
  return {
    ...model,
    get primaryRuntimeProviderId() {
      return primaryRuntimeProviderId;
    },
    async recordPrimaryConnection(runtimeProviderId, visit) {
      const currentVisit = () => {
        const state = model.getState();
        return (
          canEnter(activeHost) &&
          state.status === "open" &&
          state.visit === visit &&
          state.steps[state.stepIndex] === "providers"
        );
      };
      if (!currentVisit() || !activeHost) return "stale";
      primaryRuntimeProviderId = runtimeProviderId;
      if (!activeHost.supportsPrimaryConnection) return "local";
      const request = { runtimeProviderId, serverId: activeHost.serverId };
      try {
        await input.savePrimaryConnection(request);
      } catch (error) {
        if (error instanceof PrimaryConnectionUnavailableError)
          throw new Error(
            "This connection is no longer available in installation settings. Refresh and choose again.",
            { cause: error },
          );
        throw error;
      }
      return currentVisit() ? "saved" : "stale";
    },
    applyGate(host) {
      activeHost = host;
      model.applySetupHost(
        canEnter(host)
          ? {
              serverId: host.serverId,
              isConnected: true,
              hasHydratedWorkspaces: true,
              hasProjects: host.hasUserProjects,
            }
          : null,
        options,
      );
    },
    reopen(host) {
      if (!canEnter(host)) return;
      activeHost = host;
      disposition = "completed";
      remember = true;
      model.reopen(host.serverId, options);
    },
    skip() {
      disposition = "skipped";
      return model.complete();
    },
    pause() {
      // Visiting existing Settings is neither Skip nor Finish. The menu can reopen the guide.
      remember = false;
      return model.complete();
    },
  };
}
