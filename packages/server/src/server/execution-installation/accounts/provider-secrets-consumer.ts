import { readInstallationClientConfig } from "../settings/admission.js";
import {
  SPEECH_SECRETS_ADOPT_ROUTE,
  SPEECH_SECRETS_IMPORT_ROUTE,
  SpeechSecretsAdoptionRequestSchema,
} from "./speech-secrets-adoption.js";
import { SpeechSecretSiteSchema } from "@getpaseo/protocol/provider-secrets";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ErrorRequestHandler, Express } from "express";
import { z } from "zod";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { readClaudeSetupFile, writeClaudeSetupFile } from "./claude-setup-file.js";
import {
  ProviderSecretsDeliveryError,
  ProviderSecretsDeliverySchema,
  ProviderSecretsDeliveryService,
  ProviderSecretsJournalSchema,
  type ProviderSecretsDelivery,
} from "./provider-secrets-delivery.js";

const EnvSchema = z.record(z.string(), z.string());

interface ConsumerOptions {
  paseoHome: string;
  store: DaemonConfigStore;
  onApplied?(providerId: string): void;
  installationClientConfigFile?: string;
}

export const PROVIDER_SECRETS_ROUTE = "/api/installation/provider-secrets";

/**
 * Receives coordinator-held provider API keys and tokens into the local provider `env`.
 * Mounted behind daemon bearer authentication. Returns metadata only, never values.
 */
export function mountProviderSecretsConsumer(app: Express, options: ConsumerOptions): void {
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(PROVIDER_SECRETS_ROUTE, parseFailure);
  const consumers = new Map<string, ProviderSecretsDeliveryService>();
  async function authorize(delivery: ProviderSecretsDelivery) {
    const authority = await options.store.readInstallationSettingsAuthority();
    if (
      !authority ||
      authority.installationId !== delivery.installationId ||
      authority.serverId !== delivery.serverId ||
      (delivery.kind === "speech"
        ? delivery.policyRevision !== delivery.revision
        : authority.revision !== delivery.policyRevision)
    )
      throw new ProviderSecretsDeliveryError();
    if (delivery.kind === "speech") {
      if (
        !SpeechSecretSiteSchema.safeParse(delivery.definitionId).success ||
        delivery.providerId !== delivery.definitionId
      )
        throw new ProviderSecretsDeliveryError();
      return;
    }
    // Withdrawal stays available after a binding, definition or environment is removed.
    if (Object.keys(delivery.values).length === 0) return;
    const definition = authority.settings.providerDefinitions?.find(
      (item) => item.id === delivery.definitionId,
    );
    if (
      !definition ||
      definition.bindings[delivery.serverId] !== delivery.providerId ||
      definition.removed ||
      definition.policy.enabled === false ||
      authority.settings.resourceExclusions[delivery.serverId]?.providerIds?.includes(definition.id)
    )
      throw new ProviderSecretsDeliveryError();
  }
  // Values leave only through the trusted installation-agent channel, never this response.
  app.post(SPEECH_SECRETS_ADOPT_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const input = SpeechSecretsAdoptionRequestSchema.safeParse(req.body);
        const authority = await options.store.readInstallationSettingsAuthority();
        if (
          !input.success ||
          !authority ||
          authority.installationId !== input.data.installationId ||
          authority.serverId !== input.data.serverId ||
          authority.revision !== input.data.policyRevision
        )
          throw new ProviderSecretsDeliveryError();
        const client = readInstallationClientConfig(
          options.installationClientConfigFile ?? process.env.VORTEO_INSTALLATION_CLIENT_CONFIG,
        );
        if (
          !client ||
          (client.kind === "host-agent" ? "host" : "container") !== authority.environment
        )
          throw new ProviderSecretsDeliveryError();
        const response = await fetch(new URL(SPEECH_SECRETS_IMPORT_ROUTE, client.origin), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
          headers: { Authorization: `Bearer ${client.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...input.data, sites: options.store.readSpeechSecrets() }),
        });
        if (!response.ok) throw new ProviderSecretsDeliveryError();
        res.json({ adopted: true });
      } catch {
        res.status(409).json({ error: "Shared Voice settings are not available yet." });
      }
    })();
  });
  app.post(PROVIDER_SECRETS_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const parsed = ProviderSecretsDeliverySchema.safeParse(req.body);
        if (!parsed.success) {
          res.sendStatus(400);
          return;
        }
        const { providerId, kind } = parsed.data;
        const consumerId = JSON.stringify([kind ?? "provider", providerId]);
        let consumer = consumers.get(consumerId);
        if (!consumer) {
          const name = createHash("sha256").update(providerId).digest("hex");
          const journal = join(
            options.paseoHome,
            kind === "speech" ? "speech-secrets" : "provider-secrets",
            `${name}.json`,
          );
          consumer = new ProviderSecretsDeliveryService({
            authorize,
            read: () => {
              const value = readClaudeSetupFile(journal);
              return value === null ? null : ProviderSecretsJournalSchema.parse(value);
            },
            persist: (value) => writeClaudeSetupFile(journal, value),
            readEnv: () => {
              if (kind === "speech")
                return options.store.readSpeechSecrets(false)[providerId] ?? {};
              const provider = options.store.get().providers[providerId];
              if (!provider || provider.removed) return null;
              const env = EnvSchema.safeParse(provider.env ?? {});
              if (!env.success) throw new ProviderSecretsDeliveryError();
              return { ...env.data };
            },
            release:
              kind === "speech"
                ? () =>
                    options.store.releaseSpeechSecretManagement(
                      SpeechSecretSiteSchema.parse(providerId),
                    )
                : undefined,
            writeEnv: (env) => {
              if (kind === "speech") {
                options.store.replaceSpeechSecrets(SpeechSecretSiteSchema.parse(providerId), env);
                return;
              }
              options.store.replaceProviderEnv(providerId, env);
            },
          });
          consumers.set(consumerId, consumer);
        }
        const receipt = await consumer.apply(parsed.data);
        options.onApplied?.(providerId);
        res.json(receipt);
      } catch {
        // Never pass secret-bearing validation or I/O errors to the generic logger.
        res.status(409).json({ error: "Provider key synchronization is pending." });
      }
    })();
  });
}
