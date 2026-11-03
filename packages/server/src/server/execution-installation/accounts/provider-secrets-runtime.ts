import { randomUUID } from "node:crypto";
import {
  SPEECH_SECRETS_ADOPT_ROUTE,
  SpeechSecretsAdoptionSchema,
  type SpeechSecretsSites,
} from "./speech-secrets-adoption.js";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { join } from "node:path";
import {
  SPEECH_DEFAULT_BASE_URL,
  SPEECH_SECRET_SITES,
  SpeechSecretSiteSchema,
  SpeechSecretFieldSchema,
  SpeechSecretUpdatesSchema,
  type SpeechSecretUpdate,
  type ProviderSecretsStatus,
} from "@getpaseo/protocol/provider-secrets";
import {
  codexHostRefreshEnabled,
  requireEnvironmentDaemon,
  type InstallationConfig,
} from "../config.js";
import { connectInstallationDaemon, createInstallationRegistrationAdmission } from "../daemon.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  ProviderSecretsAuthority,
  ProviderSecretsUnsupportedError,
  type ProviderSecretsPolicy,
} from "./provider-secrets-authority.js";
import {
  ProviderSecretsDeliveryError,
  ProviderSecretsReceiptSchema,
} from "./provider-secrets-delivery.js";
import { PROVIDER_SECRETS_ROUTE } from "./provider-secrets-consumer.js";

const EnvSchema = z.record(z.string(), z.string());

interface DaemonFeatures {
  installationSettingsAuthority?: boolean;
  providerSecretDelivery?: boolean;
  speechSecretDelivery?: boolean;
}
interface RuntimeOverrides {
  /** Features and provider env of one daemon. Injected by tests. */
  inspect?: (kind: "host" | "container") => Promise<{
    features: DaemonFeatures | undefined;
    providers: Record<string, { env?: unknown } | undefined>;
  }>;
  fetch?: typeof fetch;
  now?: () => Date;
}

const FEATURE_CACHE_MS = 5 * 60_000;

/** Owner-only coordinator service for static provider secrets. Never exposes stored values. */
export function createProviderSecretsRuntime(
  config: InstallationConfig,
  settings: InstallationSettingsService,
  assertRegistrationReadiness?: (target: "host" | "container-daemon") => void,
  overrides: RuntimeOverrides = {},
) {
  const assertReady = createInstallationRegistrationAdmission(config, assertRegistrationReadiness);
  const configuration = structuredClone(config);
  const file = join(config.stateDir, "provider-secrets", "state.json");
  const request = overrides.fetch ?? fetch;
  const inspect =
    overrides.inspect ??
    (async (kind: "host" | "container") => {
      const client = await connectInstallationDaemon(config, kind);
      try {
        const features = client.getLastServerInfoMessage()?.features;
        const providers = (await client.getDaemonConfig()).config.providers;
        return { features, providers };
      } finally {
        await client.close();
      }
    });
  const supported = new Map<string, number>();
  const imports = new Map<
    string,
    {
      serverId: string;
      kind: "host" | "container";
      revision: number;
      expiresAt: number;
      sites?: SpeechSecretsSites;
    }
  >();
  const readiness = (kind: "host" | "container") =>
    assertReady(kind === "host" ? "host" : "container-daemon");
  function environment(serverId: string) {
    const found = config.public.environments.find((item) => item.serverId === serverId);
    if (!found) return undefined;
    return { kind: found.kind, label: found.kind === "host" ? "Host" : "Dev container" };
  }
  function definition(definitionId: string) {
    const snapshot = settings.snapshot();
    if (snapshot.conflicts || !snapshot.settings) throw new ProviderSecretsDeliveryError();
    const selected = snapshot.settings.providerDefinitions?.find(
      (item) => item.id === definitionId,
    );
    return { snapshot, selected };
  }
  function policy(definitionId: string): ProviderSecretsPolicy {
    const { snapshot, selected } = definition(definitionId);
    if (!selected) return { revision: Math.max(1, snapshot.revision), removed: true, targets: [] };
    const removed = selected.removed === true;
    return {
      revision: Math.max(1, snapshot.revision),
      removed,
      targets: Object.entries(selected.bindings)
        .filter(([serverId]) => environment(serverId) !== undefined)
        .map(([serverId, providerId]) => ({
          serverId,
          providerId,
          excluded:
            removed ||
            selected.policy.enabled === false ||
            Boolean(
              snapshot.settings?.resourceExclusions[serverId]?.providerIds?.includes(selected.id),
            ),
        })),
    };
  }
  async function deliver(
    delivery: import("./provider-secrets-delivery.js").ProviderSecretsDelivery,
  ) {
    const target = environment(delivery.serverId);
    if (!target) throw new ProviderSecretsDeliveryError();
    if (Object.keys(delivery.values).length > 0) readiness(target.kind);
    if (!isDeepStrictEqual(config, configuration)) throw new ProviderSecretsDeliveryError();
    const capability =
      delivery.kind === "speech" ? "speechSecretDelivery" : "providerSecretDelivery";
    const capabilityKey = `${target.kind}:${capability}`;
    const checked = supported.get(capabilityKey);
    if (checked === undefined || Date.now() - checked > FEATURE_CACHE_MS) {
      const { features } = await inspect(target.kind);
      if (features?.installationSettingsAuthority !== true || features[capability] !== true)
        throw new ProviderSecretsUnsupportedError();
      supported.set(capabilityKey, Date.now());
    }
    const daemon = requireEnvironmentDaemon(config, target.kind);
    const response = await request(`http://${daemon.endpoint}${PROVIDER_SECRETS_ROUTE}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${daemon.password}`, "Content-Type": "application/json" },
      body: JSON.stringify(delivery),
    });
    if (response.status === 404) {
      supported.delete(capabilityKey);
      throw new ProviderSecretsUnsupportedError();
    }
    if (!response.ok) throw new ProviderSecretsDeliveryError();
    return ProviderSecretsReceiptSchema.parse(await response.json());
  }
  const authority = new ProviderSecretsAuthority({
    installationId: config.public.installationId,
    read: () => readClaudeSetupFile(file) ?? [],
    persist: (state) => writeClaudeSetupFile(file, state),
    definitions: () => {
      const snapshot = settings.snapshot();
      if (snapshot.conflicts) return [];
      return (snapshot.settings?.providerDefinitions ?? [])
        .filter((item) => !item.removed && Object.keys(item.bindings).length > 0)
        .map((item) => item.id);
    },
    policy,
    environment,
    readEnvironment: async (serverId) => {
      const target = environment(serverId);
      if (!target) throw new ProviderSecretsDeliveryError();
      readiness(target.kind);
      const { providers } = await inspect(target.kind);
      return Object.fromEntries(
        Object.entries(providers).map(([id, provider]) => {
          const env = EnvSchema.safeParse(provider?.env ?? {});
          return [id, env.success ? env.data : undefined];
        }),
      );
    },
    deliver,
    now: overrides.now ?? (() => new Date()),
  });
  const speech = new ProviderSecretsAuthority({
    kind: "speech",
    installationId: config.public.installationId,
    read: () => readClaudeSetupFile(join(config.stateDir, "provider-secrets", "speech.json")) ?? [],
    persist: (state) =>
      writeClaudeSetupFile(join(config.stateDir, "provider-secrets", "speech.json"), state),
    definitions: () => [...SPEECH_SECRET_SITES],
    policy: (id) => {
      SpeechSecretSiteSchema.parse(id);
      const snapshot = settings.snapshot();
      if (!snapshot.settings || snapshot.conflicts) throw new ProviderSecretsDeliveryError();
      return {
        // Speech delivery generations belong to the credential records, not general settings.
        revision: 1,
        removed: false,
        targets: config.public.environments.map((item) => ({
          serverId: item.serverId,
          providerId: id,
          excluded: false,
        })),
      };
    },
    environment,
    readEnvironment: async (serverId) => {
      const target = environment(serverId);
      if (!target) throw new ProviderSecretsDeliveryError();
      readiness(target.kind);
      const { features } = await inspect(target.kind);
      if (features?.speechSecretDelivery !== true) throw new ProviderSecretsUnsupportedError();
      const daemon = requireEnvironmentDaemon(config, target.kind);
      const nonce = randomUUID();
      const revision = Math.max(1, settings.snapshot().revision);
      const pending = {
        serverId,
        kind: target.kind,
        revision,
        expiresAt: (overrides.now?.() ?? new Date()).getTime() + 10_000,
        sites: undefined as SpeechSecretsSites | undefined,
      };
      imports.set(nonce, pending);
      try {
        const response = await request(`http://${daemon.endpoint}${SPEECH_SECRETS_ADOPT_ROUTE}`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${daemon.password}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            nonce,
            installationId: config.public.installationId,
            serverId,
            policyRevision: revision,
          }),
        });
        if (!response.ok || !pending.sites) throw new ProviderSecretsDeliveryError();
        return pending.sites;
      } finally {
        imports.delete(nonce);
      }
    },
    deliver,
    now: overrides.now ?? (() => new Date()),
  });
  function existing(definitionId: string) {
    const { selected } = definition(definitionId);
    if (!selected) throw new ProviderSecretsDefinitionMissing();
    return selected;
  }
  /**
   * Without Host-owned Codex sign-in, Codex refresh grants stay per environment. With it, the
   * account connects once through the coordinator and no per-environment hint is reported.
   */
  function withAccountSignIn(status: ProviderSecretsStatus): ProviderSecretsStatus {
    if (codexHostRefreshEnabled(config)) return status;
    const { selected } = definition(status.definitionId);
    const codexAccount =
      selected?.providerType === "codex" &&
      (selected.accountSetup?.provider === "codex" ||
        Object.values(selected.bindings).some((id) => id.startsWith("codex-account-")));
    if (!selected || !codexAccount || selected.removed) return status;
    const policyTargets = policy(status.definitionId).targets;
    return {
      ...status,
      accountSignIn: {
        provider: "codex",
        synchronized: false,
        environments: policyTargets
          .filter((target) => !target.excluded)
          .map((target) => {
            const { kind, label } = environment(target.serverId)!;
            return { serverId: target.serverId, kind, label };
          }),
      },
    };
  }
  const kick = () => {
    void Promise.all([authority.reconcile(), speech.reconcile()]).catch(() => {});
  };
  return {
    acceptSpeechAdoption: (
      body: unknown,
      identity: { kind: "host" | "container"; serverId: string },
    ) => {
      const input = SpeechSecretsAdoptionSchema.safeParse(body);
      if (!input.success) throw new ProviderSecretsDeliveryError();
      const pending = imports.get(input.data.nonce);
      if (
        !pending ||
        pending.sites ||
        pending.expiresAt <= (overrides.now?.() ?? new Date()).getTime() ||
        pending.kind !== identity.kind ||
        pending.serverId !== identity.serverId ||
        pending.serverId !== input.data.serverId ||
        pending.revision !== input.data.policyRevision ||
        input.data.installationId !== config.public.installationId
      )
        throw new ProviderSecretsDeliveryError();
      pending.sites = input.data.sites;
    },
    read: (definitionId?: string, kind?: "speech") => {
      if (kind === "speech") {
        if (definitionId !== undefined) SpeechSecretSiteSchema.parse(definitionId);
        return definitionId === undefined ? speech.statuses() : [speech.status(definitionId)];
      }
      if (definitionId === undefined) return authority.statuses().map(withAccountSignIn);
      existing(definitionId);
      return [withAccountSignIn(authority.status(definitionId))];
    },
    set: async (definitionId: string, name: string, value: string) => {
      if (existing(definitionId).removed) throw new ProviderSecretsDeliveryError();
      await authority.set(definitionId, name, value);
      kick();
      return [withAccountSignIn(authority.status(definitionId))];
    },
    setSpeech: async (sites: SpeechSecretUpdate[]) => {
      const updates = SpeechSecretUpdatesSchema.parse(sites).map(
        ({ definitionId, expectedRevision, values }) => {
          const changes = Object.fromEntries(
            Object.entries(values).filter(
              (entry): entry is [string, string | null] => entry[1] !== undefined,
            ),
          );
          if (
            changes.baseUrl === null ||
            (Object.hasOwn(changes, "apiKey") && !Object.hasOwn(changes, "baseUrl"))
          )
            changes.baseUrl = SPEECH_DEFAULT_BASE_URL;
          return { definitionId, expectedRevision, changes };
        },
      );
      await speech.updateMany(updates);
      kick();
      return updates.map(({ definitionId }) => speech.status(definitionId));
    },
    clear: async (
      definitionId: string,
      name: string,
      kind?: "speech",
      expectedRevision?: number,
    ) => {
      if (kind === "speech") {
        SpeechSecretSiteSchema.parse(definitionId);
        SpeechSecretFieldSchema.parse(name);
        if (expectedRevision === undefined) throw new ProviderSecretsDeliveryError();
        await speech.updateMany([
          {
            definitionId,
            expectedRevision,
            changes:
              name === "baseUrl"
                ? { baseUrl: SPEECH_DEFAULT_BASE_URL }
                : { apiKey: null, baseUrl: SPEECH_DEFAULT_BASE_URL },
          },
        ]);
        kick();
        return [speech.status(definitionId)];
      }
      existing(definitionId);
      await authority.clear(definitionId, name);
      kick();
      return [withAccountSignIn(authority.status(definitionId))];
    },
    reconcile: async () => {
      await Promise.all([authority.reconcile(), speech.reconcile()]);
    },
  };
}
export type ProviderSecretsRuntime = ReturnType<typeof createProviderSecretsRuntime>;

export class ProviderSecretsDefinitionMissing extends Error {
  constructor() {
    super("The shared provider does not exist");
  }
}
