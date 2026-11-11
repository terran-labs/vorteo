import { PrimaryConnectionUnavailableError } from "@/execution-installation/primary-connection-error";
import type { InstallationSettingsSnapshot } from "@getpaseo/protocol/installation-settings";
import type { PrimaryConnectionChoice } from "@/execution-installation/primary-connection";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderUsage } from "@/provider-usage/types";
import { i18n } from "@/i18n/i18next";
import {
  createOnboardingModel,
  type OnboardingModel,
  type OnboardingStepId,
} from "../internal/model";

export interface GuideRecord {
  /** "paused" means the owner left for Settings or Add host and may come back. */
  disposition: "skipped" | "completed" | "paused";
  /** The step a paused guide reopens at. */
  step?: OnboardingStepId;
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
    return Promise.reject(new Error(i18n.t("vorteoSetup.snapshotUnsupported")));
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
  // Where Show setup again resumes after the owner left for Settings or Add host.
  let pausedStep: OnboardingStepId | null = null;
  const options = { includePhoneStep: true };
  // Reuse upstream's navigation and visit tokens. Completion here records the guide only,
  // never whether credentials have reached all environments or an account is usable. Any
  // record, including a paused one, keeps the guide from reopening by itself on reload.
  const model = createOnboardingModel({
    storage: {
      isCompleted: async () => {
        const record = await input.storage.read(input.installationId);
        if (record?.disposition === "paused") pausedStep = record.step ?? null;
        return record !== null;
      },
      markCompleted: () =>
        input.storage.write(input.installationId, {
          disposition,
          ...(disposition === "paused" && pausedStep ? { step: pausedStep } : {}),
          updatedAt: new Date().toISOString(),
        }),
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
          throw new Error(i18n.t("vorteoSetup.primaryUnavailable"), { cause: error });
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
      model.reopen(host.serverId, options);
      if (pausedStep) model.goTo(pausedStep);
      pausedStep = null;
    },
    skip() {
      disposition = "skipped";
      return model.complete();
    },
    pause() {
      // Visiting existing Settings is neither Skip nor Finish. Show setup again in More resumes
      // at this step, and a reload does not restart the guide from the first step.
      const state = model.getState();
      disposition = "paused";
      pausedStep = state.status === "open" ? (state.steps[state.stepIndex] ?? null) : null;
      return model.complete();
    },
  };
}
