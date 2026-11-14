import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  MutableDaemonConfigSchema,
  type MutableDaemonConfig,
  type MutableDaemonConfigPatch,
  type SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import {
  InstallationSettingsSchema,
  InstallationSettingsFieldSchema,
} from "@getpaseo/protocol/installation-settings";
import { installationClientOriginAllowed } from "../client-origin.js";
import { projectInstallationSettings, readInstallationSettings } from "./projection.js";

export const InstallationSettingsAdmissionSchema = z.object({
  installationId: z.string().uuid(),
  serverId: z.string().min(1),
  environment: z.enum(["host", "container"]),
  revision: z.number().int().positive(),
  settings: InstallationSettingsSchema,
  installationInstructions: z.string(),
});
export type InstallationSettingsAdmission = z.infer<typeof InstallationSettingsAdmissionSchema>;
type InstallationBinding = NonNullable<SharedProviderPreferences["installation"]>;
export interface InstallationSettingsReader {
  read(binding: InstallationBinding): Promise<InstallationSettingsAdmission>;
}

/** Creation snapshots carry this as `errorCode`, so the Host can tell an admission failure,
 * whose message names at most an origin, from an arbitrary Dev error it must not relay. */
export const INSTALLATION_SETTINGS_ADMISSION_ERROR_CODE = "installation_settings_admission";

export class InstallationSettingsAdmissionError extends Error {
  readonly code = INSTALLATION_SETTINGS_ADMISSION_ERROR_CODE;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InstallationSettingsAdmissionError";
  }
}

function candidatePolicy(current: MutableDaemonConfig, patch: MutableDaemonConfigPatch) {
  return readInstallationSettings(
    MutableDaemonConfigSchema.parse({
      ...current,
      ...patch,
      // Account bindings are environment-owned. Compare policy in the current binding context.
      providers: current.providers,
      // Speech has its own redacted read and partial-write boundary, outside shared policy.
      features: current.features,
      mcp: { ...current.mcp, ...patch.mcp },
      metadataGeneration: { ...current.metadataGeneration, ...patch.metadataGeneration },
    }),
  );
}

export function changesInstallationSettings(
  current: MutableDaemonConfig,
  patch: MutableDaemonConfigPatch,
): boolean {
  return !isDeepStrictEqual(readInstallationSettings(current), candidatePolicy(current, patch));
}

interface InstallationSettingsProjectionCheck {
  current: MutableDaemonConfig;
  patch: MutableDaemonConfigPatch;
  admission?: InstallationSettingsAdmission;
}

export function assertInstallationSettingsProjection({
  current,
  patch,
  admission,
}: InstallationSettingsProjectionCheck): void {
  const binding = current.sharedProviderPreferences?.installation;
  if (!binding || !changesInstallationSettings(current, patch)) return;
  if (!admission)
    throw new InstallationSettingsAdmissionError(
      "Shared settings must be edited through the installation coordinator.",
    );
  if (
    admission.installationId !== binding.installationId ||
    admission.serverId !== binding.serverId ||
    admission.environment !== binding.environment
  )
    throw new InstallationSettingsAdmissionError(
      "Settings authority returned a different installation or environment.",
    );
  const expected = candidatePolicy(
    current,
    projectInstallationSettings(
      admission.settings,
      binding.serverId,
      current,
      admission.installationInstructions,
    ),
  );
  const previous = readInstallationSettings(current);
  const candidate = candidatePolicy(current, patch);
  for (const key of InstallationSettingsFieldSchema.options) {
    if (
      !isDeepStrictEqual(previous[key], candidate[key]) &&
      !isDeepStrictEqual(expected[key], candidate[key])
    )
      throw new InstallationSettingsAdmissionError(
        "Shared settings must be edited through the installation coordinator. Reload its current values before retrying.",
      );
  }
}

/** The Host's delegated creation deadline must exceed this; a test asserts the margin. */
export const INSTALLATION_SETTINGS_ADMISSION_TIMEOUT_MS = 5000;

const ClientConfigSchema = z.object({
  origin: z.url(),
  token: z.string().min(1),
  kind: z.enum(["host-agent", "container-agent"]),
});

/** Internal installation transport credentials, never an RPC response. */
export function readInstallationClientConfig(
  configFile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = configFile
    ? ClientConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")))
    : null;
  if (config && !installationClientOriginAllowed(config.origin, config.kind, env))
    throw new InstallationSettingsAdmissionError(
      "Installation admission requires a fixed HTTPS, loopback or gate route origin.",
    );
  return config;
}

export function createInstallationSettingsReader(
  configFile: string | undefined,
  fetchAdmission: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): InstallationSettingsReader {
  const config = readInstallationClientConfig(configFile, env);
  return {
    async read(binding) {
      if (!config)
        throw new InstallationSettingsAdmissionError(
          "The daemon launcher must configure VORTEO_INSTALLATION_CLIENT_CONFIG before projecting shared settings.",
        );
      const environment = config.kind === "host-agent" ? "host" : "container";
      if (binding.environment !== environment)
        throw new InstallationSettingsAdmissionError(
          "Installation settings environment does not match the daemon launcher.",
        );
      // Node's fetch keeps no HTTP cache, so no cache mode is needed; the entrypoint builds, which
      // type against Node alone, reject the DOM-only option.
      // COMPAT(projectPolicies, primaryConnection, timeZoneSetting): older coordinators ignore
      // the query and omit the newer fields.
      const url = new URL(
        "/api/installation/settings/admission?projectPolicies=1&primaryConnection=1&timeZone=1",
        config.origin,
      );
      let response: Response;
      try {
        response = await fetchAdmission(url, {
          headers: { Authorization: `Bearer ${config.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(INSTALLATION_SETTINGS_ADMISSION_TIMEOUT_MS),
        });
      } catch (error) {
        if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
        // The origin was validated as bare scheme, host and port above, so it carries no secret.
        throw new InstallationSettingsAdmissionError(
          `Installation settings authority at ${config.origin} did not respond within ${INSTALLATION_SETTINGS_ADMISSION_TIMEOUT_MS / 1000} seconds.`,
          { cause: error },
        );
      }
      if (!response.ok)
        throw new InstallationSettingsAdmissionError(
          `Installation settings authority is unavailable (${response.status}).`,
        );
      return InstallationSettingsAdmissionSchema.parse(await response.json());
    },
  };
}

let launchSettingsReader: InstallationSettingsReader | undefined;
export async function readInstallationSettingsForLaunch(
  settings: MutableDaemonConfig,
  reader?: InstallationSettingsReader,
): Promise<InstallationSettingsAdmission | null> {
  const binding = settings.sharedProviderPreferences?.installation;
  if (!binding) {
    if (process.env.VORTEO_INSTALLATION_CLIENT_CONFIG)
      throw new InstallationSettingsAdmissionError(
        "Installation settings migration is incomplete.",
      );
    return null;
  }
  if (!reader) {
    launchSettingsReader ??= createInstallationSettingsReader(
      process.env.VORTEO_INSTALLATION_CLIENT_CONFIG,
    );
    reader = launchSettingsReader;
  }
  const admission = await reader.read(binding);
  if (
    admission.installationId !== binding.installationId ||
    admission.serverId !== binding.serverId ||
    admission.environment !== binding.environment
  )
    throw new InstallationSettingsAdmissionError(
      "Settings authority returned a different installation or environment.",
    );
  if (!admission.settings.skillLibrary)
    throw new InstallationSettingsAdmissionError(
      "Complete shared personal skill migration before starting new tasks.",
    );
  return admission;
}
