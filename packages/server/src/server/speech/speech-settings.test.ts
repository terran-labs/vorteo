import { expect, test } from "vitest";
import { PersistedConfigSchema } from "../persisted-config.js";
import { readSpeechSecretSettings, readSpeechSettings } from "./speech-settings.js";

const binding = {
  version: 1 as const,
  revision: 1,
  providers: {},
  legacyProfiles: {},
  installation: {
    installationId: "11111111-1111-4111-8111-111111111111",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  },
};

const KEY = "synthetic-speech-settings-key";

test("private adoption captures effective credentials for all sites, including dormant local sites", () => {
  const persisted = PersistedConfigSchema.parse({
    features: { dictation: { stt: { provider: "openai", apiKey: KEY } } },
  });
  expect(
    readSpeechSecretSettings(persisted, {
      OPENAI_API_KEY: "synthetic-global-key",
      OPENAI_STT_API_KEY: "synthetic-stt-key",
      OPENAI_TTS_BASE_URL: "https://speech.example/v1",
    }),
  ).toEqual({
    "dictation.stt": { apiKey: KEY, baseUrl: "https://api.openai.com/v1" },
    "voiceMode.stt": { apiKey: "synthetic-stt-key", baseUrl: "https://api.openai.com/v1" },
    "voiceMode.tts": { apiKey: "synthetic-global-key", baseUrl: "https://speech.example/v1" },
  });
});

test("ordinary speech settings never reveal credentials or the internal delivery marker", () => {
  const persisted = PersistedConfigSchema.parse({
    daemon: { sharedProviderPreferences: binding },
    features: {
      dictation: { stt: { provider: "openai", apiKey: KEY, credentialsManaged: true } },
      voiceMode: { tts: { provider: "local", apiKey: KEY, credentialsManaged: true } },
    },
  });
  const read = readSpeechSettings(persisted, { OPENAI_API_KEY: KEY });
  expect(read.features.dictation.stt).toMatchObject({ provider: "openai", hasApiKey: true });
  expect(JSON.stringify(read)).not.toContain(KEY);
  expect(JSON.stringify(read)).not.toContain("credentialsManaged");
  expect(read.envOverrides["features.dictation.stt.apiKey"]).toBeUndefined();
});

test("cleared shared sites cannot re-adopt credentials from process environment", () => {
  const persisted = PersistedConfigSchema.parse({
    daemon: { sharedProviderPreferences: binding },
    features: {
      dictation: { stt: { provider: "openai", credentialsManaged: true } },
      voiceMode: {
        stt: { provider: "local", credentialsManaged: true },
        tts: { provider: "local", credentialsManaged: true },
      },
    },
  });
  expect(readSpeechSecretSettings(persisted, { OPENAI_API_KEY: KEY })).toEqual({
    "dictation.stt": {},
    "voiceMode.stt": {},
    "voiceMode.tts": {},
  });
});

test("baseUrl without a key is never adopted from persisted fields or process env", () => {
  const persisted = PersistedConfigSchema.parse({
    features: { dictation: { stt: { provider: "openai", baseUrl: "https://evil.example" } } },
  });
  expect(readSpeechSecretSettings(persisted, { OPENAI_BASE_URL: "https://evil.example" })).toEqual({
    "dictation.stt": {},
    "voiceMode.stt": {},
    "voiceMode.tts": {},
  });
});

test("a standalone stale marker does not suppress environment credentials", () => {
  const persisted = PersistedConfigSchema.parse({
    features: { dictation: { stt: { provider: "openai", credentialsManaged: true } } },
  });
  expect(readSpeechSecretSettings(persisted, { OPENAI_API_KEY: KEY })["dictation.stt"]).toEqual({
    apiKey: KEY,
    baseUrl: "https://api.openai.com/v1",
  });
});
