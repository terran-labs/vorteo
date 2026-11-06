import express from "express";
import { hashSync } from "bcryptjs";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { SPEECH_SECRET_SITES } from "@getpaseo/protocol/provider-secrets";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { createRequireBearerMiddleware } from "../../auth.js";
import { PersistedConfigSchema, loadPersistedConfig } from "../../persisted-config.js";
import { createSpeechSettingsOwner } from "../../speech/speech-settings.js";
import { resolveSpeechConfig } from "../../speech/speech-config-resolver.js";
import { readInstallationSettings } from "../settings/projection.js";
import type { InstallationSettingsService } from "../settings/service.js";
import type { InstallationConfig } from "../config.js";
import { mountProviderSecretsConsumer } from "./provider-secrets-consumer.js";
import { createProviderSecretsRuntime } from "./provider-secrets-runtime.js";
import { mountProviderSecretsRoutes } from "./provider-secrets-routes.js";
import {
  SPEECH_SECRETS_ADOPT_ROUTE,
  SPEECH_SECRETS_IMPORT_ROUTE,
} from "./speech-secrets-adoption.js";

const KEY = `synthetic-speech-${"a".repeat(24)}`;
// Exercise real bearer verification without making password work factor dominate adoption timing.
const PASSWORD_HASH = hashSync("synthetic-daemon-password", 4);
const OTHER = `synthetic-speech-${"b".repeat(24)}`;

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test listener");
  return {
    server,
    endpoint: `127.0.0.1:${address.port}`,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function installation(conflict = false) {
  const root = await mkdtemp(join(tmpdir(), "speech-secrets-integration-"));
  const servers: Server[] = [];
  const owner = express();
  owner.use(express.json());
  const coordinator = await listen(owner);
  servers.push(coordinator.server);
  const installationId = randomUUID();
  const stores: Record<string, DaemonConfigStore> = {};
  const homes: Record<string, string> = {};
  const endpoints: Record<string, string> = {};
  const credentials: Record<string, string> = {};
  const offline = new Set<string>();
  const revision = 1;
  for (const kind of ["host", "container"] as const) {
    const serverId = kind === "host" ? "host" : "dev";
    const home = await mkdtemp(join(root, `${serverId}-`));
    homes[serverId] = home;
    const binding = { installationId, serverId, environment: kind, revision };
    const preferences = {
      version: 1 as const,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    };
    let existing: Record<string, string> = {};
    if (kind === "host") existing = { apiKey: KEY, baseUrl: "https://one.example/v1" };
    else if (conflict) existing = { apiKey: OTHER, baseUrl: "https://two.example/v1" };
    const persisted = PersistedConfigSchema.parse({
      daemon: { sharedProviderPreferences: preferences },
      features: {
        dictation: {
          stt: {
            provider: "openai",
            ...existing,
          },
        },
        voiceMode: { stt: { provider: "local" }, tts: { provider: "local" } },
      },
    });
    await writeFile(join(home, "config.json"), JSON.stringify(persisted), { mode: 0o600 });
    const initial = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers: {},
      sharedProviderPreferences: preferences,
    });
    const policy = readInstallationSettings(initial);
    const store = new DaemonConfigStore(home, initial, undefined, {
      startupPersisted: persisted,
      speech: createSpeechSettingsOwner({
        paseoHome: home,
        env: {},
        speechService: { reconfigure() {} },
      }),
      installationSettingsReader: {
        read: async () => ({ ...binding, settings: policy, installationInstructions: "" }),
      },
    });
    stores[serverId] = store;
    const clientFile = join(home, "installation-client.json");
    const token = `synthetic-${kind}-agent`;
    credentials[kind] = token;
    await writeFile(
      clientFile,
      JSON.stringify({ origin: coordinator.origin, token, kind: `${kind}-agent` }),
      { mode: 0o600 },
    );
    const daemon = express();
    daemon.use(
      createRequireBearerMiddleware({
        password: PASSWORD_HASH,
      }),
    );
    daemon.use(express.json());
    mountProviderSecretsConsumer(daemon, {
      paseoHome: home,
      store,
      installationClientConfigFile: clientFile,
    });
    const listener = await listen(daemon);
    servers.push(listener.server);
    endpoints[kind] = listener.endpoint;
  }
  const config = {
    stateDir: root,
    public: {
      installationId,
      environments: [
        { serverId: "host", kind: "host" },
        { serverId: "dev", kind: "container" },
      ],
    },
    host: { endpoint: endpoints.host, password: "synthetic-daemon-password" },
    container: { endpoint: endpoints.container, password: "synthetic-daemon-password" },
  } as unknown as InstallationConfig;
  const settings = {
    snapshot: () => ({ revision, settings: readInstallationSettings(stores.host!.get()) }),
  } as unknown as InstallationSettingsService;
  const runtime = createProviderSecretsRuntime(config, settings, undefined, {
    inspect: async (kind) => {
      if (offline.has(kind)) throw Error("synthetic offline environment");
      return {
        features: {
          installationSettingsAuthority: true,
          providerSecretDelivery: true,
          speechSecretDelivery: true,
        },
        providers: {},
      };
    },
  });
  mountProviderSecretsRoutes(owner, runtime, (req) => {
    const token = req.header("authorization");
    if (token === `Bearer ${credentials.host}`) return { kind: "host", serverId: "host" };
    if (token === `Bearer ${credentials.container}`) return { kind: "container", serverId: "dev" };
    return null;
  });
  async function request(
    path: string,
    body: unknown,
    origin = coordinator.origin,
    bearer?: string,
    cookie?: string,
  ) {
    return fetch(new URL(path, origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(cookie ? { Cookie: `vorteo-owner=${cookie}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  return {
    root,
    stores,
    homes,
    runtime,
    offline,
    request,
    endpoints,
    installationId,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function assertDeliveredEnvironment(home: string, store: DaemonConfigStore) {
  const features = loadPersistedConfig(home).features!;
  for (const site of [features.dictation?.stt, features.voiceMode?.stt, features.voiceMode?.tts])
    expect(site).toMatchObject({
      apiKey: OTHER,
      baseUrl: "https://chosen.example/v1",
      credentialsManaged: true,
    });
  expect(JSON.stringify(store.get())).not.toContain(OTHER);
  await store.patchFromClient({
    features: { voiceMode: { tts: { provider: "openai" } } },
  });
  expect(loadPersistedConfig(home).features?.voiceMode?.tts?.apiKey).toBe(OTHER);
  await expect(
    store.patchFromClient({ features: { voiceMode: { tts: { apiKey: KEY } } } }),
  ).rejects.toThrow("shared Voice settings");
  for (const file of await readdir(join(home, "speech-secrets"))) {
    expect(await readFile(join(home, "speech-secrets", file), "utf8")).not.toContain(OTHER);
    if (process.platform !== "win32")
      expect((await stat(join(home, "speech-secrets", file))).mode & 0o777).toBe(0o600);
  }
}

async function assertUnboundMarkerCleanup(home: string, store: DaemonConfigStore) {
  const persisted = loadPersistedConfig(home);
  const preferences = { ...persisted.daemon!.sharedProviderPreferences! };
  delete preferences.installation;
  persisted.daemon!.sharedProviderPreferences = preferences;
  await writeFile(join(home, "config.json"), JSON.stringify(persisted));
  const initial = { ...store.get(), sharedProviderPreferences: preferences };
  const standalone = new DaemonConfigStore(home, initial, undefined, {
    startupPersisted: persisted,
    speech: createSpeechSettingsOwner({
      paseoHome: home,
      env: { OPENAI_TTS_API_KEY: KEY },
      speechService: { reconfigure() {} },
    }),
  });
  expect(loadPersistedConfig(home).features?.voiceMode?.tts?.credentialsManaged).toBeUndefined();
  expect(standalone.readSpeechSecrets()["voiceMode.tts"]!.apiKey).toBe(KEY);
}

test("speech adoption and atomic saves reach every environment without returning keys to clients", async () => {
  const h = await installation();
  try {
    // Before a speech-capable coordinator reconciles, an upgraded Host remains a passive
    // recipient. Legacy admission and rejected local key edits must leave its key usable.
    const host = h.stores.host!;
    const hostHome = h.homes.host!;
    const before = await readFile(join(hostHome, "config.json"), "utf8");
    await host.readInstallationSettingsAuthority();
    await expect(
      host.patchFromClient({ features: { dictation: { stt: { apiKey: OTHER } } } }),
    ).rejects.toThrow("shared Voice settings");
    expect(await readFile(join(hostHome, "config.json"), "utf8")).toBe(before);
    expect(
      resolveSpeechConfig({
        paseoHome: hostHome,
        persisted: loadPersistedConfig(hostHome),
        env: {},
      }).openai?.dictationStt?.apiKey,
    ).toBe(KEY);
    expect(
      loadPersistedConfig(hostHome).features?.dictation?.stt?.credentialsManaged,
    ).toBeUndefined();
    await expect(stat(join(hostHome, "speech-secrets"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(h.root, "provider-secrets", "speech.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await h.runtime.reconcile();
    for (const home of Object.values(h.homes)) {
      expect(loadPersistedConfig(home).features?.dictation?.stt?.apiKey).toBe(KEY);
      // Never-configured sites do not become managed merely because they were scanned.
      expect(
        loadPersistedConfig(home).features?.voiceMode?.tts?.credentialsManaged,
      ).toBeUndefined();
    }
    const ownerRead = await h.request("/api/installation/owner/provider-secrets/read", {
      kind: "speech",
    });
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.text()).not.toContain(KEY);
    const saved = await h.request("/api/installation/owner/provider-secrets/set", {
      kind: "speech",
      sites: SPEECH_SECRET_SITES.map((definitionId) => ({
        definitionId,
        expectedRevision: h.runtime.read(definitionId, "speech")[0]!.revision,
        values: { apiKey: OTHER, baseUrl: "https://chosen.example/v1" },
      })),
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(OTHER);
    await h.runtime.reconcile();
    for (const [id, home] of Object.entries(h.homes)) {
      await assertDeliveredEnvironment(home, h.stores[id]!);
    }
    await h.runtime.clear(
      "voiceMode.tts",
      "apiKey",
      "speech",
      h.runtime.read("voiceMode.tts", "speech")[0]!.revision,
    );
    await h.runtime.reconcile();
    for (const home of Object.values(h.homes)) {
      const persisted = loadPersistedConfig(home);
      expect(persisted.features?.voiceMode?.tts?.apiKey).toBeUndefined();
      expect(
        resolveSpeechConfig({ paseoHome: home, persisted, env: { OPENAI_API_KEY: KEY } }).openai
          ?.tts,
      ).toBeUndefined();
    }
    const denied = await h.request(
      SPEECH_SECRETS_IMPORT_ROUTE,
      { apiKey: KEY },
      undefined,
      undefined,
      "synthetic-owner-session",
    );
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(KEY);
    const badNonce = await h.request(
      SPEECH_SECRETS_ADOPT_ROUTE,
      {
        nonce: randomUUID(),
        installationId: h.installationId,
        serverId: "host",
        policyRevision: h.stores.host!.get().sharedProviderPreferences!.installation!.revision,
      },
      `http://${h.endpoints.host}`,
      "synthetic-daemon-password",
    );
    expect(badNonce.status).toBe(409);
    expect(await badNonce.text()).not.toContain(KEY);
    await assertUnboundMarkerCleanup(h.homes.host!, h.stores.host!);
  } finally {
    await h.close();
  }
}, 60_000);

test("conflicting speech endpoints block delivery until the owner saves a single credential pair", async () => {
  const h = await installation(true);
  try {
    await h.runtime.reconcile();
    const [status] = h.runtime.read("dictation.stt", "speech");
    expect(status!.ready).toBe(false);
    expect(status!.conflicts.map((item) => item.name).sort()).toEqual(["apiKey", "baseUrl"]);
    expect(loadPersistedConfig(h.homes.dev!).features?.dictation?.stt?.apiKey).toBe(OTHER);
    await h.runtime.setSpeech([
      {
        definitionId: "dictation.stt",
        expectedRevision: status!.revision!,
        values: { apiKey: KEY, baseUrl: "https://chosen.example/v1" },
      },
    ]);
    await h.runtime.reconcile();
    expect(h.runtime.read("dictation.stt", "speech")[0]!.ready).toBe(true);
    for (const home of Object.values(h.homes))
      expect(loadPersistedConfig(home).features?.dictation?.stt).toMatchObject({
        apiKey: KEY,
        baseUrl: "https://chosen.example/v1",
      });
  } finally {
    await h.close();
  }
}, 60_000);

test("offline adoption waits for all environments and then adopts once", async () => {
  const h = await installation();
  try {
    h.offline.add("container");
    await h.runtime.reconcile();
    expect(h.runtime.read("dictation.stt", "speech")[0]!.ready).toBe(false);
    expect(loadPersistedConfig(h.homes.dev!).features?.dictation?.stt?.apiKey).toBeUndefined();
    h.offline.clear();
    await h.runtime.reconcile();
    expect(h.runtime.read("dictation.stt", "speech")[0]!.ready).toBe(true);
    expect(loadPersistedConfig(h.homes.dev!).features?.dictation?.stt?.apiKey).toBe(KEY);
  } finally {
    await h.close();
  }
}, 60_000);
