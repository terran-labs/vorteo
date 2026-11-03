import type { SpeechSettings, SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import {
  SPEECH_DEFAULT_BASE_URL,
  SPEECH_SECRET_SITES,
  type SpeechSecretSite,
} from "@getpaseo/protocol/provider-secrets";

interface VoiceSavePorts {
  shared: boolean;
  current: SpeechSettings | undefined;
  local(patch: SpeechSettingsPatch): Promise<unknown>;
  credentials(
    site: SpeechSecretSite,
    values: { apiKey?: string | null; baseUrl?: string | null },
  ): Promise<unknown>;
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
  const saved = [
    ports.current?.dictation.stt,
    ports.current?.voiceMode.stt,
    ports.current?.voiceMode.tts,
  ];
  const credentials: {
    site: SpeechSecretSite;
    values: { apiKey?: string | null; baseUrl?: string | null };
  }[] = [];
  for (const [index, site] of sites.entries()) {
    if (!site) continue;
    const values: { apiKey?: string | null; baseUrl?: string | null } = {};
    if (site.apiKey !== undefined) values.apiKey = site.apiKey as string | null;
    if (site.baseUrl !== undefined) values.baseUrl = site.baseUrl as string | null;
    // Bind a submitted key to this endpoint, including the shared default, in one revision.
    if (values.apiKey && !Object.hasOwn(values, "baseUrl")) {
      const previous = saved[index]?.baseUrl;
      values.baseUrl = typeof previous === "string" ? previous : SPEECH_DEFAULT_BASE_URL;
    }
    if (Object.keys(values).length) credentials.push({ site: SPEECH_SECRET_SITES[index]!, values });
    delete site.apiKey;
    delete site.baseUrl;
  }
  // Provider changes must settle first so they cannot erase a just-delivered key.
  await ports.local(local);
  for (const change of credentials) await ports.credentials(change.site, change.values);
}
