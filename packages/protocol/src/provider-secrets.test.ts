import { expect, test } from "vitest";
import {
  ProviderSecretSetRequestSchema,
  ProviderSecretClearRequestSchema,
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

test("speech requests accept atomic pairs and explicit clears only in their own scope", () => {
  expect(
    ProviderSecretSetRequestSchema.safeParse({
      kind: "speech",
      definitionId: "voiceMode.tts",
      values: { apiKey: KEY, baseUrl: null },
    }).success,
  ).toBe(true);
  expect(
    ProviderSecretClearRequestSchema.safeParse({
      kind: "speech",
      definitionId: "dictation.stt",
      name: "apiKey",
    }).success,
  ).toBe(true);
  for (const patch of [
    { definitionId: "unknown" },
    { values: {} },
    { values: { OPENAI_API_KEY: KEY } },
    { values: { apiKey: "\nsynthetic-invalid" } },
    { kind: undefined },
  ]) {
    expect(
      ProviderSecretSetRequestSchema.safeParse({
        kind: "speech",
        definitionId: "dictation.stt",
        values: { apiKey: KEY },
        ...patch,
      }).success,
    ).toBe(false);
  }
});
