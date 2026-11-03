import { z } from "zod";

/**
 * Static provider secrets (API keys and tokens) that the installation coordinator stores once
 * and delivers into every bound environment's provider `env`. Only names that read as secrets
 * are synchronized; runtime locations such as CODEX_HOME or CLAUDE_CONFIG_DIR stay local.
 */
export const PROVIDER_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,126}_(KEY|TOKEN|SECRET|PASSWORD)$/;
/** Owned by Claude subscription synchronization, never by static secret delivery. */
export const RESERVED_PROVIDER_SECRET_NAMES: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN"];

export function isProviderSecretName(name: string): boolean {
  return PROVIDER_SECRET_NAME_PATTERN.test(name) && !RESERVED_PROVIDER_SECRET_NAMES.includes(name);
}

export const ProviderSecretNameSchema = z
  .string()
  .refine(
    isProviderSecretName,
    "Use an environment variable name ending in _KEY, _TOKEN, _SECRET or _PASSWORD",
  );
export const SPEECH_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const SpeechSecretSiteSchema = z.enum(["dictation.stt", "voiceMode.stt", "voiceMode.tts"]);
export type SpeechSecretSite = z.infer<typeof SpeechSecretSiteSchema>;
export const SPEECH_SECRET_SITES = SpeechSecretSiteSchema.options;
export const SpeechSecretFieldSchema = z.enum(["apiKey", "baseUrl"]);
export type SpeechSecretField = z.infer<typeof SpeechSecretFieldSchema>;
export function isSpeechSecretField(name: string): name is SpeechSecretField {
  return SpeechSecretFieldSchema.safeParse(name).success;
}
export function isInstallationSecretName(name: string): boolean {
  return isProviderSecretName(name) || isSpeechSecretField(name);
}
const DefinitionIdSchema = z.string().min(1).max(512);

/** POST /api/installation/owner/provider-secrets/read */
export const ProviderSecretsReadRequestSchema = z.strictObject({
  definitionId: DefinitionIdSchema.optional(),
  kind: z.literal("speech").optional(),
});
/** POST /api/installation/owner/provider-secrets/set. The value is never returned. */
export const SpeechSecretValueSchema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .refine(
    (value) =>
      value.trim() === value &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    "Remove surrounding spaces and line breaks",
  );
/** HTTPS everywhere; plaintext only for localhost and literal loopback/private IPs. */
export const SpeechBaseUrlSchema = SpeechSecretValueSchema.pipe(z.string().max(2048)).refine(
  (value) => {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.hash || value.includes("#")) return false;
      if (url.protocol === "https:") return true;
      if (url.protocol !== "http:") return false;
      const host = url.hostname;
      if (host === "localhost" || host === "[::1]" || /^\[f[cd][0-9a-f]{2}:/iu.test(host))
        return true;
      const parts = host.split(".").map(Number);
      if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
      )
        return false;
      return (
        parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
        (parts[0] === 192 && parts[1] === 168)
      );
    } catch {
      return false;
    }
  },
  "Use HTTPS, or HTTP with localhost or a literal private IP; omit credentials and fragments",
);
export const SpeechSecretValuesSchema = z
  .strictObject({
    apiKey: SpeechSecretValueSchema.nullable().optional(),
    baseUrl: SpeechBaseUrlSchema.nullable().optional(),
  })
  .refine((values) => Object.values(values).some((value) => value !== undefined));
export const SpeechSecretUpdateSchema = z.strictObject({
  definitionId: SpeechSecretSiteSchema,
  expectedRevision: z.number().int().nonnegative(),
  values: SpeechSecretValuesSchema,
});
export const SpeechSecretUpdatesSchema = z
  .array(SpeechSecretUpdateSchema)
  .min(1)
  .max(3)
  .refine((sites) => new Set(sites.map((site) => site.definitionId)).size === sites.length);
export type SpeechSecretUpdate = z.infer<typeof SpeechSecretUpdateSchema>;
const ProviderSecretTargetSchema = z.strictObject({
  kind: z.undefined().optional(),
  definitionId: DefinitionIdSchema,
  name: ProviderSecretNameSchema,
});
const SpeechSecretTargetSchema = z.strictObject({
  kind: z.literal("speech"),
  definitionId: SpeechSecretSiteSchema,
  name: SpeechSecretFieldSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export const ProviderSecretSetRequestSchema = z.discriminatedUnion("kind", [
  ProviderSecretTargetSchema.extend({ value: SpeechSecretValueSchema }),
  z.strictObject({
    kind: z.literal("speech"),
    sites: SpeechSecretUpdatesSchema,
  }),
]);
/** Speech credentials use the same owner-only routes, with an explicit separate scope. */
export const ProviderSecretClearRequestSchema = z.discriminatedUnion("kind", [
  ProviderSecretTargetSchema,
  SpeechSecretTargetSchema,
]);

export const ProviderSecretSummarySchema = z.strictObject({
  name: z.string(),
  /** Last four characters, only for values long enough not to reveal them. */
  last4: z.string().length(4).nullable(),
  updatedAt: z.string().datetime(),
  /** "imported" values were adopted once from an environment's existing configuration. */
  source: z.enum(["owner", "imported"]),
});
export const ProviderSecretEnvironmentStatusSchema = z.strictObject({
  serverId: z.string(),
  kind: z.enum(["host", "container"]),
  /**
   * delivered: the environment applied the current secrets (or their withdrawal).
   * pending: delivery has not completed yet and has not failed.
   * failed: the last attempt failed or found a differing local value; see message.
   * excluded: the provider is removed, disabled or excluded here; secrets are withdrawn.
   */
  status: z.enum(["delivered", "pending", "failed", "excluded"]),
  message: z.string().optional(),
  /** Secret names whose differing local value was left untouched in this environment. */
  conflicts: z.array(z.string()).optional(),
});
export const ProviderSecretConflictSchema = z.strictObject({
  name: z.string(),
  /** Environments whose existing values differ. Set the value once to resolve. */
  serverIds: z.array(z.string()),
});
export const ProviderSecretsStatusSchema = z.strictObject({
  definitionId: z.string(),
  /** Present for speech records; required on the next owner write. */
  revision: z.number().int().nonnegative().optional(),
  secrets: z.array(ProviderSecretSummarySchema),
  environments: z.array(ProviderSecretEnvironmentStatusSchema),
  /** Import found different values in several environments and adopted none of them. */
  conflicts: z.array(ProviderSecretConflictSchema),
  /** True when every non-excluded bound environment has the current secrets. */
  ready: z.boolean(),
  /**
   * Present for sign-in accounts whose credentials are not synchronized between environments.
   * Codex keeps a refresh grant per environment, so each listed environment needs its own
   * sign-in ("Sign in on <label>"). Signed-in state comes from that environment's provider status.
   */
  accountSignIn: z
    .strictObject({
      provider: z.literal("codex"),
      synchronized: z.literal(false),
      environments: z.array(
        z.strictObject({
          serverId: z.string(),
          kind: z.enum(["host", "container"]),
          label: z.string(),
        }),
      ),
    })
    .optional(),
});
export type ProviderSecretsStatus = z.infer<typeof ProviderSecretsStatusSchema>;
export type ProviderSecretEnvironmentStatus = z.infer<typeof ProviderSecretEnvironmentStatusSchema>;
/** Response of read, set and clear. set/clear return only the affected definition. */
export const ProviderSecretsReadResponseSchema = z.strictObject({
  definitions: z.array(ProviderSecretsStatusSchema),
});
export type ProviderSecretsReadResponse = z.infer<typeof ProviderSecretsReadResponseSchema>;
