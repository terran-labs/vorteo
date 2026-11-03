import { expect, test } from "vitest";
import type { SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import type { SpeechSecretUpdate } from "@getpaseo/protocol/provider-secrets";
import { saveVoiceSettings } from "./save-voice-settings";

const KEY = "synthetic-voice-test-key";
const revisions = new Map([
  ["dictation.stt", 2],
  ["voiceMode.stt", 4],
  ["voiceMode.tts", 1],
]);

test("standalone Voice saves keep using the local settings port", async () => {
  const calls: SpeechSettingsPatch[] = [];
  const patch = { dictation: { stt: { provider: "openai", apiKey: KEY } } };
  await saveVoiceSettings(patch, {
    shared: false,
    revisions,
    local: async (value) => {
      calls.push(value);
    },
    credentials: async () => {
      throw Error("Shared transport used outside an installation");
    },
  });
  expect(calls).toEqual([patch]);
});

test("installation saves commit one validated multi-site batch before switching providers", async () => {
  const local: SpeechSettingsPatch[] = [];
  const shared: SpeechSecretUpdate[][] = [];
  const patch = {
    dictation: { stt: { provider: "openai", apiKey: KEY } },
    voiceMode: {
      stt: { provider: "openai", apiKey: KEY, baseUrl: "https://speech.example/v1" },
      tts: { provider: "openai", apiKey: KEY, baseUrl: null },
    },
  };
  await saveVoiceSettings(patch, {
    shared: true,
    revisions,
    local: async (value) => {
      expect(shared).toHaveLength(1);
      local.push(value);
    },
    credentials: async (sites) => {
      expect(local).toHaveLength(0);
      shared.push(sites);
    },
  });
  expect(JSON.stringify(local)).not.toContain(KEY);
  expect(shared).toEqual([
    [
      {
        definitionId: "dictation.stt",
        expectedRevision: 2,
        values: { apiKey: KEY, baseUrl: "https://api.openai.com/v1" },
      },
      {
        definitionId: "voiceMode.stt",
        expectedRevision: 4,
        values: { apiKey: KEY, baseUrl: "https://speech.example/v1" },
      },
      {
        definitionId: "voiceMode.tts",
        expectedRevision: 1,
        values: { apiKey: KEY, baseUrl: null },
      },
    ],
  ]);
  expect(patch.dictation.stt.apiKey).toBe(KEY);
});

test("failed shared saves never switch providers or write local keys", async () => {
  const calls: SpeechSettingsPatch[] = [];
  await expect(
    saveVoiceSettings(
      { dictation: { stt: { provider: "openai", apiKey: KEY } } },
      {
        shared: true,
        revisions,
        local: async (value) => {
          calls.push(value);
        },
        credentials: async () => {
          throw Error("Settings changed on another client. Reload before saving again.");
        },
      },
    ),
  ).rejects.toThrow("Settings changed on another client");
  expect(calls).toEqual([]);
});

test("a key-only save resets to the default endpoint rather than carrying shared configuration", async () => {
  const shared: SpeechSecretUpdate[][] = [];
  await saveVoiceSettings(
    { dictation: { stt: { apiKey: KEY } } },
    {
      shared: true,
      revisions,
      local: async () => {},
      credentials: async (sites) => {
        shared.push(sites);
      },
    },
  );
  expect(shared[0]![0]!.values.baseUrl).toBe("https://api.openai.com/v1");
});

test("invalid or partially loaded batches have no side effects", async () => {
  const calls: unknown[] = [];
  for (const [patch, loaded] of [
    [
      { dictation: { stt: { apiKey: KEY, baseUrl: "https://attacker:password@example.com" } } },
      revisions,
    ],
    [{ dictation: { stt: { apiKey: KEY } } }, new Map()],
  ] as const) {
    await expect(
      saveVoiceSettings(patch, {
        shared: true,
        revisions: loaded,
        local: async (value) => {
          calls.push(value);
        },
        credentials: async (sites) => {
          calls.push(sites);
        },
      }),
    ).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});

test("old speech metadata asks for a coordinator update instead of an endless refresh", async () => {
  await expect(
    saveVoiceSettings(
      { dictation: { stt: { apiKey: KEY } } },
      {
        shared: true,
        revisions: new Map([["dictation.stt", undefined]]),
        local: async () => {
          throw Error("Local provider changed");
        },
        credentials: async () => {
          throw Error("Stale save submitted");
        },
      },
    ),
  ).rejects.toThrow("Update the coordinator to share Voice keys");
});
