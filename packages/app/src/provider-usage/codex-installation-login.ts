import { z } from "zod";
import { ProviderLoginStateSchema } from "@getpaseo/protocol/provider-login";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import {
  InstallationRequestFailed,
  InstallationRouteUnavailable,
  OwnerAccessExpired,
  requestInstallationOwner,
} from "@/execution-installation/client";
import { requestInstallationSettings } from "@/execution-installation/settings";
import { readExecutionInstallation } from "@/execution-installation/policy";
import type { ClaudeSetupConnectionSchema } from "./claude-setup-login";

const EnvironmentStatusSchema = z.strictObject({
  serverId: z.string(),
  status: z.enum(["ready", "pending", "excluded", "disconnected", "disconnecting"]),
});
// Host-owned sign-in status. Parsed leniently so newer coordinators can add fields.
const ReadSchema = z.object({
  login: ProviderLoginStateSchema,
  connection: z.object({
    signedIn: z.boolean(),
    needsSignIn: z.boolean(),
    identity: z.object({ email: z.string().nullable() }).nullable(),
    environments: z.array(EnvironmentStatusSchema),
  }),
});

/** A Codex definition from before the installation managed Codex. */
function isLegacyCodex(item: InstallationProvider): boolean {
  return (
    item.providerType === "codex" && item.accountId !== undefined && item.accountSetup === undefined
  );
}

/**
 * Resolve the exact shared binding, never an account label or a cached native sign-in. A legacy
 * account qualifies only once it is adopted; the coordinator refuses it otherwise.
 */
async function codexDefinition(serverId: string, providerId: string) {
  const snapshot = await requestInstallationSettings();
  const definitions = snapshot.settings?.providerDefinitions?.filter(
    (item) =>
      item.providerType === "codex" &&
      (item.accountSetup?.provider === "codex" || isLegacyCodex(item)) &&
      !item.removed &&
      item.bindings[serverId] === providerId,
  );
  if (!definitions || definitions.length !== 1)
    throw new Error("Refresh shared account settings before connecting Codex.");
  return definitions[0]!;
}

/**
 * Whether this Codex account signs in through the coordinator. The coordinator signs in only
 * accounts the installation created (with an `accountSetup` record) and refuses the rest, so an
 * older account bound here without one keeps its environment's own sign-in, which writes the
 * account's CODEX_HOME. An account not yet in the settings snapshot is assumed to be a new
 * installation account.
 */
export async function codexAccountUsesInstallationSignIn(
  serverId: string,
  providerId: string,
): Promise<boolean> {
  const snapshot = await requestInstallationSettings();
  const bound = (snapshot.settings?.providerDefinitions ?? []).filter(
    (item) =>
      item.providerType === "codex" && !item.removed && item.bindings[serverId] === providerId,
  );
  if (bound.length === 0 || bound.some((item) => item.accountSetup?.provider === "codex"))
    return true;
  // An adopted legacy account signs in on the Host too, which repairs Dev as well.
  const legacy = bound.find(isLegacyCodex);
  if (!legacy) return false;
  const adoption = (await codexAdoptions())?.find((item) => item.definitionId === legacy.id);
  return adoption?.adoption?.status === "adopted" || adoption?.adoption?.status === "projecting";
}

// Parsed leniently, as the sign-in read is, so newer coordinators can add fields and states.
const AdoptionSchema = z.object({
  status: z.string(),
  error: z.string().nullable(),
  projectedAt: z.number().nullable().optional(),
  restored: z.object({ mayNeedSignIn: z.boolean() }).nullable(),
  restoreSkipped: z.boolean().optional(),
  copyDeleteBlocked: z.string().optional(),
  hostSignInNeeded: z.boolean().optional(),
});
const AdoptionsSchema = z.object({
  definitions: z.array(
    z.object({
      definitionId: z.string(),
      eligible: z.boolean(),
      reason: z.string().nullable(),
      adoption: AdoptionSchema.nullable(),
    }),
  ),
});
export type CodexAdoption = z.infer<typeof AdoptionSchema>;

/**
 * Every legacy Codex account the coordinator could adopt, or null when the coordinator has no
 * adoption routes: an older coordinator, or one without Host-owned Codex sign-in. This is the
 * one place that detects support; everything downstream reads this shape.
 */
async function codexAdoptions() {
  try {
    return AdoptionsSchema.parse(await requestInstallationOwner("codex/signin/adoptions", "", {}))
      .definitions;
  } catch (error) {
    if (error instanceof InstallationRouteUnavailable) return null;
    throw error;
  }
}

/** The legacy account bound to this provider, with whether it can be adopted, or null. */
export async function codexAdoptionRead(serverId: string, providerId: string) {
  const snapshot = await requestInstallationSettings();
  const legacy = (snapshot.settings?.providerDefinitions ?? []).filter(
    (item) => isLegacyCodex(item) && !item.removed && item.bindings[serverId] === providerId,
  );
  if (legacy.length !== 1) return null;
  const entries = await codexAdoptions();
  const entry = entries?.find((item) => item.definitionId === legacy[0]!.id);
  if (!entry) return null;
  // Where this account's Host sign-in runs, for a failure that a Host sign-in repairs.
  const hostServerId =
    readExecutionInstallation()?.environments.find((environment) => environment.kind === "host")
      ?.serverId ?? null;
  const hostProviderId = hostServerId ? legacy[0]!.bindings[hostServerId] : undefined;
  return {
    ...entry,
    host:
      hostServerId && hostProviderId
        ? { serverId: hostServerId, providerId: hostProviderId }
        : null,
  };
}

/** Adopts or un-adopts one legacy account. A refusal throws with the coordinator's reason. */
export async function codexAdoptionRequest(
  definitionId: string,
  operation: "adopt" | "unadopt",
): Promise<void> {
  await requestInstallationOwner(`codex/signin/${operation}`, "", { definitionId });
}

/**
 * One Codex sign-in for the installation. Whichever environment the owner opens it from, the
 * coordinator signs the Host account in and delivers it to Dev; there is no environment choice.
 */
export async function codexInstallationRequest(
  serverId: string,
  providerId: string,
  operation: "read" | "start" | "cancel" | "sign-out",
  attempt?: { attemptId: string },
): Promise<{
  login: z.infer<typeof ProviderLoginStateSchema>;
  connection: z.infer<typeof ClaudeSetupConnectionSchema> | undefined;
}> {
  const definition = await codexDefinition(serverId, providerId);
  const result = await requestInstallationOwner(`codex/signin/${operation}`, "", {
    definitionId: definition.id,
    ...attempt,
  });
  if (operation !== "read" && operation !== "sign-out")
    return { login: ProviderLoginStateSchema.parse(result), connection: undefined };
  const { login, connection } = ReadSchema.parse(result);
  return {
    login,
    connection: {
      connected: connection.signedIn && !connection.needsSignIn,
      environments: connection.environments,
      needsSignIn: connection.needsSignIn,
      ...(connection.identity?.email ? { accountLabel: connection.identity.email } : {}),
    },
  };
}

/**
 * Whether the coordinator runs Host-owned Codex sign-in. Its owner routes exist only when the
 * installation enables it, and they refuse an unknown definition with 409. Any other failure
 * keeps the environment's own sign-in.
 */
export async function codexInstallationSignInAvailable(): Promise<boolean> {
  try {
    await requestInstallationOwner("codex/signin/read", "", { definitionId: "availability" });
    return false;
  } catch (error) {
    if (error instanceof OwnerAccessExpired) throw error;
    return error instanceof InstallationRequestFailed && error.status === 409;
  }
}
