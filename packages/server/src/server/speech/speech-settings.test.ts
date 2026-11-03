import { expect, test } from "vitest";
import { PersistedConfigSchema } from "../persisted-config.js";
import { readSpeechSecretSettings, readSpeechSettings } from "./speech-settings.js";

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
