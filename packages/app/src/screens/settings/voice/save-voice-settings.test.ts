import { expect, test } from "vitest";
import type { SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import { saveVoiceSettings } from "./save-voice-settings";

const KEY = "synthetic-voice-test-key";

test("standalone Voice saves keep using the local settings port", async () => {
  const calls: SpeechSettingsPatch[] = [];
  const patch = {
    dictation: { stt: { provider: "openai", apiKey: KEY, baseUrl: "https://speech.example/v1" } },
  };
  await saveVoiceSettings(patch, {
    shared: false,
    current: undefined,
    local: async (value) => {
      calls.push(value);
    },
    credentials: async () => {
      throw Error("Shared transport used outside an installation");
    },
  });
  expect(calls).toEqual([patch]);
});

test("installation saves strip every site's credentials from the ordinary RPC and batch shared pairs", async () => {
  const local: SpeechSettingsPatch[] = [];
  const shared: { site: string; values: unknown }[] = [];
  const patch = {
    dictation: { stt: { provider: "openai", apiKey: KEY } },
    voiceMode: {
      stt: { provider: "openai", apiKey: KEY, baseUrl: "https://speech.example/v1" },
      tts: { provider: "openai", apiKey: KEY, baseUrl: null },
    },
  };
  await saveVoiceSettings(patch, {
    shared: true,
    current: undefined,
    local: async (value) => {
      local.push(value);
    },
    credentials: async (site, values) => {
      expect(local).toHaveLength(1);
      shared.push({ site, values });
    },
  });
  expect(JSON.stringify(local)).not.toContain(KEY);
  expect(local).toEqual([
    {
      dictation: { stt: { provider: "openai" } },
      voiceMode: { stt: { provider: "openai" }, tts: { provider: "openai" } },
    },
  ]);
  expect(shared).toEqual([
    { site: "dictation.stt", values: { apiKey: KEY, baseUrl: "https://api.openai.com/v1" } },
    { site: "voiceMode.stt", values: { apiKey: KEY, baseUrl: "https://speech.example/v1" } },
    { site: "voiceMode.tts", values: { apiKey: KEY, baseUrl: null } },
  ]);
  expect(patch.dictation.stt.apiKey).toBe(KEY);
});

test("failed shared saves stay failed and never fall back to local key storage", async () => {
  const calls: SpeechSettingsPatch[] = [];
  await expect(
    saveVoiceSettings(
      { dictation: { stt: { apiKey: KEY } } },
      {
        shared: true,
        current: undefined,
        local: async (value) => {
          calls.push(value);
        },
        credentials: async () => {
          throw Error("Owner access required");
        },
      },
    ),
  ).rejects.toThrow("Owner access required");
  expect(JSON.stringify(calls)).not.toContain(KEY);
});

test("a key-only edit retains the site's custom endpoint in the same shared save", async () => {
  const shared: unknown[] = [];
  await saveVoiceSettings(
    { dictation: { stt: { apiKey: KEY } } },
    {
      shared: true,
      current: {
        dictation: {
          enabled: true,
          stt: { provider: "openai", hasApiKey: true, baseUrl: "https://speech.example/v1" },
        },
        voiceMode: { enabled: false, stt: { provider: "local" }, tts: { provider: "local" } },
      },
      local: async () => {},
      credentials: async (site, values) => {
        shared.push({ site, values });
      },
    },
  );
  expect(shared).toEqual([
    { site: "dictation.stt", values: { apiKey: KEY, baseUrl: "https://speech.example/v1" } },
  ]);
});
