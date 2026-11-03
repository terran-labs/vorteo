import {
  SPEECH_SECRET_SITES,
  SPEECH_DEFAULT_BASE_URL,
  SpeechBaseUrlSchema,
} from "@getpaseo/protocol/provider-secrets";
import type { SpeechSettings, SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";

import {
  PersistedConfigSchema,
  SpeechSttConfigSchema,
  SpeechTtsConfigSchema,
  type PersistedConfig,
} from "../persisted-config.js";
import { resolveRequestedSpeechProviders, resolveSpeechConfig } from "./speech-config-resolver.js";
import type { SpeechService } from "./speech-runtime.js";
import { LocalSttModelIdSchema, LocalTtsModelIdSchema } from "./providers/local/models.js";

interface SpeechRead {
  features: SpeechSettings;
  envOverrides: Record<string, string>;
}

// Owns the per-site wire boundary: credential redaction, env provenance and patch
// semantics. The store never assembles or merges provider objects itself.
export interface SpeechSettingsOwner {
  read(persisted: PersistedConfig): SpeechRead;
  apply(persisted: PersistedConfig): void;
  readSecrets?(persisted: PersistedConfig): Record<string, Record<string, string>>;
}

export function createSpeechSettingsOwner(params: {
  paseoHome: string;
  env: NodeJS.ProcessEnv;
  speechService: Pick<SpeechService, "reconfigure">;
}): SpeechSettingsOwner {
  const { paseoHome, env, speechService } = params;
  return {
    read: (persisted) => readSpeechSettings(persisted, env),
    readSecrets: (persisted) => readSpeechSecretSettings(persisted, env),
    apply: (persisted) => {
      const resolved = resolveSpeechConfig({ paseoHome, env, persisted });
      speechService.reconfigure({ openaiConfig: resolved.openai, speechConfig: resolved.speech });
    },
  };
}

export function readSpeechSettings(persisted: PersistedConfig, env: NodeJS.ProcessEnv): SpeechRead {
  const dictation = persisted.features?.dictation;
  const voiceMode = persisted.features?.voiceMode;
  const providers = resolveRequestedSpeechProviders({ persisted, env });
  const envOverrides: Record<string, string> = {};
  const recordOverride = (path: string, names: string[], fallback?: unknown) => {
    if (fallback !== undefined) return;
    const name = names.find((candidate) => env[candidate]?.trim());
    if (name) envOverrides[path] = name;
  };
  recordOverride("features.dictation.enabled", ["PASEO_DICTATION_ENABLED"]);
  recordOverride("features.voiceMode.enabled", ["PASEO_VOICE_MODE_ENABLED"]);
  recordOverride("features.voiceMode.turnDetection.provider", [
    "PASEO_VOICE_TURN_DETECTION_PROVIDER",
  ]);

  function readSite(
    site: Record<string, unknown> | undefined,
    provider: string,
    path: string,
    kind: "stt" | "tts",
    providerEnv: string,
    localModelEnv: string,
  ) {
    recordOverride(`${path}.provider`, [providerEnv]);
    const configured = site?.provider === provider ? site : undefined;
    const { apiKey, credentialsManaged, ...fields } = configured ?? {};
    const openaiModelEnv = kind === "stt" ? "STT_MODEL" : "TTS_MODEL";
    recordOverride(`${path}.model`, [provider === "openai" ? openaiModelEnv : localModelEnv]);
    if (kind === "stt") {
      const languageVars =
        path === "features.dictation.stt"
          ? ["PASEO_DICTATION_LANGUAGE"]
          : ["PASEO_VOICE_LANGUAGE", "PASEO_DICTATION_LANGUAGE"];
      recordOverride(`${path}.language`, languageVars);
    }
    if (provider === "openai") {
      for (const [field, suffix] of [
        ["apiKey", "API_KEY"],
        ["baseUrl", "BASE_URL"],
      ] as const) {
        if (credentialsManaged && persisted.daemon?.sharedProviderPreferences?.installation)
          continue;
        recordOverride(
          `${path}.${field}`,
          [`OPENAI_${kind.toUpperCase()}_${suffix}`, `OPENAI_${suffix}`],
          configured?.[field],
        );
      }
      if (kind === "stt") {
        recordOverride(`${path}.confidenceThreshold`, ["STT_CONFIDENCE_THRESHOLD"]);
      } else recordOverride(`${path}.voice`, ["TTS_VOICE"]);
    } else if (kind === "tts") {
      recordOverride(`${path}.speakerId`, ["PASEO_VOICE_LOCAL_TTS_SPEAKER_ID"]);
      recordOverride(`${path}.speed`, ["PASEO_VOICE_LOCAL_TTS_SPEED"]);
    }
    return {
      ...fields,
      provider,
      ...(provider === "openai"
        ? { hasApiKey: typeof apiKey === "string" && apiKey.trim().length > 0 }
        : {}),
    };
  }

  return {
    features: {
      dictation: {
        enabled: providers.dictationStt.enabled !== false,
        stt: readSite(
          dictation?.stt,
          providers.dictationStt.provider,
          "features.dictation.stt",
          "stt",
          "PASEO_DICTATION_STT_PROVIDER",
          "PASEO_DICTATION_LOCAL_STT_MODEL",
        ),
      },
      voiceMode: {
        enabled: providers.voiceStt.enabled !== false,
        ...(voiceMode?.llm ? { llm: voiceMode.llm } : {}),
        ...(voiceMode?.turnDetection
          ? {
              turnDetection: {
                ...voiceMode.turnDetection,
                provider: providers.voiceTurnDetection.provider,
              },
            }
          : {}),
        stt: readSite(
          voiceMode?.stt,
          providers.voiceStt.provider,
          "features.voiceMode.stt",
          "stt",
          "PASEO_VOICE_STT_PROVIDER",
          "PASEO_VOICE_LOCAL_STT_MODEL",
        ),
        tts: readSite(
          voiceMode?.tts,
          providers.voiceTts.provider,
          "features.voiceMode.tts",
          "tts",
          "PASEO_VOICE_TTS_PROVIDER",
          "PASEO_VOICE_LOCAL_TTS_MODEL",
        ),
      },
    },
    envOverrides,
  };
}

/** Private installation adoption view. Never use for ordinary config responses. */
export function readSpeechSecretSettings(
  persisted: PersistedConfig,
  env: NodeJS.ProcessEnv,
): Record<string, Record<string, string>> {
  const features = persisted.features;
  const sites = [features?.dictation?.stt, features?.voiceMode?.stt, features?.voiceMode?.tts];
  const text = (...values: (string | undefined)[]) => values.find((value) => value?.trim())?.trim();
  return Object.fromEntries(
    SPEECH_SECRET_SITES.map((id, index): [string, Record<string, string>] => {
      const site = sites[index];
      const fallback =
        !persisted.daemon?.sharedProviderPreferences?.installation || !site?.credentialsManaged;
      const kind = index === 2 ? "TTS" : "STT";
      const apiKey = text(
        site?.apiKey,
        fallback ? env[`OPENAI_${kind}_API_KEY`] : undefined,
        fallback ? env.OPENAI_API_KEY : undefined,
      );
      const baseUrl = text(
        site?.baseUrl,
        fallback ? env[`OPENAI_${kind}_BASE_URL`] : undefined,
        fallback ? env.OPENAI_BASE_URL : undefined,
      );
      return [
        id,
        apiKey && SpeechBaseUrlSchema.safeParse(baseUrl ?? SPEECH_DEFAULT_BASE_URL).success
          ? { apiKey, baseUrl: baseUrl ?? SPEECH_DEFAULT_BASE_URL }
          : {},
      ];
    }),
  );
}

function mergeFields(current: Record<string, unknown> | undefined, patch: Record<string, unknown>) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || (typeof value === "string" && !value.trim())) delete next[key];
    else next[key] = typeof value === "string" ? value.trim() : value;
  }
  return next;
}

function mergeSite(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
  kind: "stt" | "tts",
  preserveCredentials: boolean,
) {
  const providerChanged =
    patch.provider !== undefined && patch.provider !== (current?.provider ?? "local");
  // Shared credentials stay available even when this environment chooses a local model.
  const retained = preserveCredentials
    ? {
        apiKey: current?.apiKey,
        baseUrl: current?.baseUrl,
        credentialsManaged: current?.credentialsManaged,
      }
    : undefined;
  const next = mergeFields(providerChanged ? retained : current, patch);
  next.provider ??= "local";
  const site = (kind === "stt" ? SpeechSttConfigSchema : SpeechTtsConfigSchema).parse(next);
  if (site.provider === "local" && site.model !== undefined) {
    const schema = kind === "stt" ? LocalSttModelIdSchema : LocalTtsModelIdSchema;
    if (!schema.safeParse(site.model).success) {
      throw new Error(
        `Unknown local ${kind === "stt" ? "speech-to-text" : "voice"} model: ${site.model}`,
      );
    }
  }
  return site;
}

export function mergeSpeechSettingsPatch(
  persisted: PersistedConfig,
  patch: SpeechSettingsPatch,
): PersistedConfig {
  const features = { ...persisted.features };
  const preserveCredentials = Boolean(persisted.daemon?.sharedProviderPreferences?.installation);
  if (patch.dictation) {
    const { stt, ...rest } = patch.dictation;
    const next = mergeFields(features.dictation, rest);
    if (stt) next.stt = mergeSite(features.dictation?.stt, stt, "stt", preserveCredentials);
    features.dictation = PersistedConfigSchema.shape.features.unwrap().shape.dictation.parse(next);
  }
  if (patch.voiceMode) {
    const { stt, tts, llm, turnDetection, ...rest } = patch.voiceMode;
    const next = mergeFields(features.voiceMode, rest);
    if (stt) next.stt = mergeSite(features.voiceMode?.stt, stt, "stt", preserveCredentials);
    if (tts) next.tts = mergeSite(features.voiceMode?.tts, tts, "tts", preserveCredentials);
    if (llm) next.llm = mergeFields(features.voiceMode?.llm, llm);
    if (turnDetection)
      next.turnDetection = mergeFields(features.voiceMode?.turnDetection, turnDetection);
    features.voiceMode = PersistedConfigSchema.shape.features.unwrap().shape.voiceMode.parse(next);
  }
  return { ...persisted, features };
}

/** Raw persisted fields only. Delivery must never materialize process-environment fallbacks. */
export function readPersistedSpeechSecrets(
  persisted: PersistedConfig,
): Record<string, Record<string, string>> {
  const sites = [
    persisted.features?.dictation?.stt,
    persisted.features?.voiceMode?.stt,
    persisted.features?.voiceMode?.tts,
  ];
  return Object.fromEntries(
    SPEECH_SECRET_SITES.map((id, index) => {
      const site = sites[index];
      return [
        id,
        {
          ...(site?.apiKey ? { apiKey: site.apiKey } : {}),
          ...(site?.baseUrl ? { baseUrl: site.baseUrl } : {}),
        },
      ];
    }),
  );
}

export function releaseSpeechCredentials(persisted: PersistedConfig): PersistedConfig {
  const next = structuredClone(persisted);
  for (const site of [
    next.features?.dictation?.stt,
    next.features?.voiceMode?.stt,
    next.features?.voiceMode?.tts,
  ])
    if (site) delete site.credentialsManaged;
  return next;
}
