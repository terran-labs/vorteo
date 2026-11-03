import type { SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import {
  SPEECH_DEFAULT_BASE_URL,
  SPEECH_SECRET_SITES,
  SpeechSecretUpdatesSchema,
  type SpeechSecretUpdate,
} from "@getpaseo/protocol/provider-secrets";

interface VoiceSavePorts {
  shared: boolean;
  revisions: ReadonlyMap<string, number | undefined>;
  local(patch: SpeechSettingsPatch): Promise<unknown>;
  credentials(sites: SpeechSecretUpdate[]): Promise<unknown>;
}

/** Keys never travel through the ordinary settings RPC in an installation. */
export async function saveVoiceSettings(
  patch: SpeechSettingsPatch,
  ports: VoiceSavePorts,
): Promise<void> {
  if (!ports.shared) {
    await ports.local(patch);
    return;
  }
  const local = structuredClone(patch);
  const sites = [local.dictation?.stt, local.voiceMode?.stt, local.voiceMode?.tts];
  const credentials: SpeechSecretUpdate[] = [];
  for (const [index, site] of sites.entries()) {
    if (!site) continue;
    const values: { apiKey?: string | null; baseUrl?: string | null } = {};
    if (site.apiKey !== undefined) values.apiKey = site.apiKey as string | null;
    if (site.baseUrl !== undefined) values.baseUrl = site.baseUrl as string | null;
    // Bind a submitted key to this endpoint, including the shared default, in one revision.
    if (values.apiKey && !Object.hasOwn(values, "baseUrl")) {
      values.baseUrl = SPEECH_DEFAULT_BASE_URL;
    }
    if (Object.keys(values).length) {
      const definitionId = SPEECH_SECRET_SITES[index]!;
      const expectedRevision = ports.revisions.get(definitionId);
      if (expectedRevision === undefined)
        throw new Error(
          ports.revisions.has(definitionId)
            ? "Update the coordinator to share Voice keys"
            : "Refresh shared Voice settings before saving.",
        );
      credentials.push({ definitionId, expectedRevision, values });
    }
    delete site.apiKey;
    delete site.baseUrl;
  }
  // Validate and commit the whole credential batch before any provider can switch.
  if (credentials.length) await ports.credentials(SpeechSecretUpdatesSchema.parse(credentials));
  await ports.local(local);
}
