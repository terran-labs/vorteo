import { expect, test } from "vitest";
import {
  ProviderSecretSetRequestSchema,
  ProviderSecretClearRequestSchema,
  SpeechBaseUrlSchema,
  SpeechSecretUpdatesSchema,
} from "./provider-secrets.js";

const KEY = "synthetic-protocol-speech-key";

test("existing provider requests remain valid without a kind", () => {
  expect(
    ProviderSecretSetRequestSchema.safeParse({
      definitionId: "account/test",
      name: "OPENAI_API_KEY",
      value: KEY,
    }).success,
  ).toBe(true);
});

test("speech batches require revisions, distinct valid sites and clean credential fields", () => {
  const site = {
    definitionId: "voiceMode.tts",
    expectedRevision: 1,
    values: { apiKey: KEY, baseUrl: null },
  };
  expect(ProviderSecretSetRequestSchema.safeParse({ kind: "speech", sites: [site] }).success).toBe(
    true,
  );
  expect(
    ProviderSecretClearRequestSchema.safeParse({
      kind: "speech",
      definitionId: "dictation.stt",
      name: "apiKey",
      expectedRevision: 1,
    }).success,
  ).toBe(true);
  for (const patch of [
    { definitionId: "unknown" },
    { expectedRevision: undefined },
    { values: {} },
    { values: { OPENAI_API_KEY: KEY } },
    { values: { apiKey: "\nsynthetic-invalid" } },
    { values: { apiKey: "synthetic\tinvalid" } },
  ])
    expect(SpeechSecretUpdatesSchema.safeParse([{ ...site, ...patch }]).success).toBe(false);
  expect(SpeechSecretUpdatesSchema.safeParse([site, site]).success).toBe(false);
});

test("speech endpoints allow HTTPS or literal private HTTP without URL credentials or fragments", () => {
  for (const url of [
    "https://speech.example/v1",
    "http://localhost:8080/v1",
    "http://127.0.0.1/v1",
    "http://10.2.3.4/v1",
    "http://172.16.0.1/v1",
    "http://192.168.1.2/v1",
    "http://[::1]/v1",
    "http://[fd00::1]/v1",
  ])
    expect(SpeechBaseUrlSchema.safeParse(url).success).toBe(true);
  for (const url of [
    "http://public.example/v1",
    "http://8.8.8.8/v1",
    "http://172.32.0.1/v1",
    "https://user:password@speech.example/v1",
    "https://speech.example/#",
    "https://speech.example/#key",
    "ftp://speech.example",
    "https://speech.example/\nkey",
    "https://" + "a".repeat(2048),
  ])
    expect(SpeechBaseUrlSchema.safeParse(url).success).toBe(false);
});
