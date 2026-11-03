import { z } from "zod";
import {
  SpeechSecretSiteSchema,
  SpeechSecretFieldSchema,
} from "@getpaseo/protocol/provider-secrets";

export const SPEECH_SECRETS_ADOPT_ROUTE = "/api/installation/provider-secrets/speech/adopt";
export const SPEECH_SECRETS_IMPORT_ROUTE = "/api/installation/agent/speech-secrets/adopt";
export const SpeechSecretsSitesSchema = z.record(
  SpeechSecretSiteSchema,
  z.partialRecord(SpeechSecretFieldSchema, z.string()),
);
export const SpeechSecretsAdoptionRequestSchema = z.strictObject({
  nonce: z.string().uuid(),
  installationId: z.string().uuid(),
  serverId: z.string().min(1),
  policyRevision: z.number().int().positive(),
});
export const SpeechSecretsAdoptionSchema = SpeechSecretsAdoptionRequestSchema.extend({
  sites: SpeechSecretsSitesSchema,
});
export type SpeechSecretsSites = z.infer<typeof SpeechSecretsSitesSchema>;
