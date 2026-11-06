import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import type { InstallationConfig } from "../config.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { createProviderSecretsRuntime } from "./provider-secrets-runtime.js";
import {
  SPEECH_SECRETS_ADOPT_ROUTE,
  SpeechSecretsAdoptionRequestSchema,
  SpeechSecretsAdoptionSchema,
} from "./speech-secrets-adoption.js";
import {
  providerSecretsDeliveryDigest,
  type ProviderSecretsDelivery,
} from "./provider-secrets-delivery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sites = { "dictation.stt": {}, "voiceMode.stt": {}, "voiceMode.tts": {} };
type Adoption = ReturnType<typeof SpeechSecretsAdoptionRequestSchema.parse>;
interface Identity {
  kind: "host" | "container";
  serverId: string;
}

function harness(
  onAdopt?: (
    body: Adoption,
    identity: Identity,
    runtime: ReturnType<typeof createProviderSecretsRuntime>,
    advance: () => void,
  ) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "speech-runtime-security-"));
  roots.push(root);
  let now = Date.parse("2026-11-03T00:00:00Z");
  const state = {
    settingsRevision: 1,
    deliveries: [] as ProviderSecretsDelivery[],
    adoption: null as Adoption | null,
  };
  const config = {
    stateDir: root,
    public: {
      installationId: randomUUID(),
      environments: [
        { serverId: "host", kind: "host" },
        { serverId: "dev", kind: "container" },
      ],
    },
    host: { endpoint: "127.0.0.1:1", password: "synthetic-host" },
    container: { endpoint: "127.0.0.1:2", password: "synthetic-container" },
  } as unknown as InstallationConfig;
  const settings = {
    snapshot: () => ({
      revision: state.settingsRevision,
      settings: { providerDefinitions: [], resourceExclusions: {} },
    }),
  } as unknown as InstallationSettingsService;
  const runtime = createProviderSecretsRuntime(config, settings, undefined, {
    now: () => new Date(now),
    inspect: async () => ({
      features: { speechSecretDelivery: true, installationSettingsAuthority: true },
      providers: {},
    }),
    fetch: (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith(SPEECH_SECRETS_ADOPT_ROUTE)) {
        const adoption = SpeechSecretsAdoptionRequestSchema.parse(body);
        const identity: Identity = {
          kind: adoption.serverId === "host" ? "host" : "container",
          serverId: adoption.serverId,
        };
        state.adoption = adoption;
        if (onAdopt)
          onAdopt(adoption, identity, runtime, () => {
            now += 10_001;
          });
        else runtime.acceptSpeechAdoption({ ...adoption, sites }, identity);
        return Response.json({ adopted: true });
      }
      const delivery = body as ProviderSecretsDelivery;
      state.deliveries.push(delivery);
      const { values: _values, overwrite: _overwrite, ...scope } = delivery;
      return Response.json({
        ...scope,
        digest: providerSecretsDeliveryDigest(delivery),
        conflicts: [],
        phase: "applied",
      });
    }) as typeof fetch,
  });
  return { runtime, state };
}

test("adoption nonces accept once and reject wrong roles and different server identities", async () => {
  const h = harness((body, identity, runtime) => {
    const push = { ...body, sites };
    expect(() =>
      runtime.acceptSpeechAdoption({ ...push, nonce: randomUUID() }, identity),
    ).toThrow();
    const wrong: Identity = { ...identity, kind: identity.kind === "host" ? "container" : "host" };
    expect(() => runtime.acceptSpeechAdoption(push, wrong)).toThrow();
    expect(() =>
      runtime.acceptSpeechAdoption(push, { ...identity, serverId: "another-container" }),
    ).toThrow();
    runtime.acceptSpeechAdoption(push, identity);
    expect(() => runtime.acceptSpeechAdoption(push, identity)).toThrow();
  });
  await h.runtime.reconcile();
  expect(h.runtime.read("dictation.stt", "speech")[0]!.ready).toBe(true);
  const body = h.state.adoption!;
  expect(() =>
    h.runtime.acceptSpeechAdoption({ ...body, sites }, { kind: "container", serverId: "dev" }),
  ).toThrow();
});

test("expired or endpoint-only adoption cannot populate authority", async () => {
  const expired = harness((body, identity, runtime, advance) => {
    advance();
    expect(() => runtime.acceptSpeechAdoption({ ...body, sites }, identity)).toThrow();
  });
  await expired.runtime.reconcile();
  expect(expired.runtime.read("dictation.stt", "speech")[0]!.ready).toBe(false);
  const planted = harness((body, identity, runtime) => {
    expect(() =>
      runtime.acceptSpeechAdoption(
        { ...body, sites: { ...sites, "dictation.stt": { baseUrl: "https://evil.example" } } },
        identity,
      ),
    ).toThrow();
  });
  await planted.runtime.reconcile();
  expect(planted.runtime.read("dictation.stt", "speech")[0]!.secrets).toEqual([]);
});

test("concurrent stale saves reject without partial writes, and unrelated settings do not redeliver", async () => {
  const h = harness();
  await h.runtime.reconcile();
  const revision = h.runtime.read("dictation.stt", "speech")[0]!.revision!;
  const save = () =>
    h.runtime.setSpeech([
      {
        definitionId: "dictation.stt",
        expectedRevision: revision,
        values: { apiKey: "synthetic-runtime-key" },
      },
    ]);
  const results = await Promise.allSettled([save(), save()]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  const oldTts = h.runtime.read("voiceMode.tts", "speech")[0]!;
  await expect(
    h.runtime.setSpeech([
      {
        definitionId: "voiceMode.tts",
        expectedRevision: oldTts.revision!,
        values: { apiKey: "synthetic-tts" },
      },
      {
        definitionId: "dictation.stt",
        expectedRevision: revision,
        values: { apiKey: "synthetic-stale" },
      },
    ]),
  ).rejects.toThrow("Settings changed on another client");
  expect(h.runtime.read("voiceMode.tts", "speech")[0]).toEqual(oldTts);
  await h.runtime.reconcile();
  const deliveries = h.state.deliveries.length;
  h.state.settingsRevision += 1;
  await h.runtime.reconcile();
  expect(h.state.deliveries).toHaveLength(deliveries);
  expect(h.state.deliveries[0]!.values.baseUrl).toBe("https://api.openai.com/v1");
  expect(
    h.state.deliveries.every((delivery) => delivery.policyRevision === delivery.revision),
  ).toBe(true);
});

test("pushed adoption values have bounded clean keys and validated endpoint URLs", () => {
  const base = {
    nonce: randomUUID(),
    installationId: randomUUID(),
    serverId: "host",
    policyRevision: 1,
  };
  for (const values of [
    { apiKey: "x".repeat(16 * 1024 + 1) },
    { apiKey: "synthetic\nkey" },
    { apiKey: "synthetic\tkey" },
    { apiKey: "synthetic-key", baseUrl: "https://user:pass@example.com" },
    { apiKey: "synthetic-key", baseUrl: "https://example.com/#fragment" },
  ])
    expect(
      SpeechSecretsAdoptionSchema.safeParse({
        ...base,
        sites: { ...sites, "dictation.stt": values },
      }).success,
    ).toBe(false);
});
