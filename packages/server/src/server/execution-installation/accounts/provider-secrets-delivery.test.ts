import { expect, test } from "vitest";
import {
  ProviderSecretsDeliveryService,
  providerSecretsDeliveryDigest,
  type ProviderSecretsJournal,
} from "./provider-secrets-delivery.js";

const KEY = `sk-synthetic-${"a".repeat(32)}`;
const OTHER = `sk-synthetic-${"b".repeat(32)}`;
const delivery = {
  installationId: "11111111-1111-4111-8111-111111111111",
  serverId: "dev",
  definitionId: "openai",
  providerId: "openai-local",
  revision: 1,
  policyRevision: 5,
  values: { OPENAI_API_KEY: KEY },
  overwrite: [] as string[],
};

function fixture(env: Record<string, string> | null = { OPENAI_BASE_URL: "https://local" }) {
  const state: {
    journal: ProviderSecretsJournal | null;
    env: Record<string, string> | null;
    authorized: boolean;
    writes: number;
  } = { journal: null, env, authorized: true, writes: 0 };
  const ports = {
    read: () => state.journal,
    persist: (journal: ProviderSecretsJournal) => {
      state.journal = journal;
    },
    readEnv: () => (state.env ? { ...state.env } : null),
    writeEnv: (next: Record<string, string>) => {
      state.writes += 1;
      state.env = next;
    },
    authorize: async () => {
      if (!state.authorized) throw Error("excluded");
    },
  };
  return { state, service: new ProviderSecretsDeliveryService(ports) };
}

test("writes values beside local env and journals digests only", async () => {
  const f = fixture();
  const receipt = await f.service.apply(delivery);
  expect(receipt).toMatchObject({ phase: "applied", conflicts: [], revision: 1 });
  expect(receipt.digest).toBe(providerSecretsDeliveryDigest(delivery));
  expect(f.state.env).toEqual({ OPENAI_BASE_URL: "https://local", OPENAI_API_KEY: KEY });
  expect(JSON.stringify(f.state.journal)).not.toContain(KEY);
  expect(JSON.stringify(receipt)).not.toContain(KEY);
  // Identical retries are idempotent and do not rewrite configuration.
  await f.service.apply(delivery);
  expect(f.state.writes).toBe(1);
});

test("withdraws only names it delivered and leaves locally changed values", async () => {
  const f = fixture();
  await f.service.apply({
    ...delivery,
    values: { OPENAI_API_KEY: KEY, OTHER_TOKEN: OTHER },
  });
  f.state.env!.OTHER_TOKEN = "changed-locally-value";
  await f.service.apply({ ...delivery, revision: 2, values: {} });
  expect(f.state.env).toEqual({
    OPENAI_BASE_URL: "https://local",
    OTHER_TOKEN: "changed-locally-value",
  });
});

test("never silently replaces a differing local value unless the owner set it", async () => {
  const f = fixture({ OPENAI_API_KEY: OTHER });
  const imported = await f.service.apply(delivery);
  expect(imported.conflicts).toEqual(["OPENAI_API_KEY"]);
  expect(f.state.env).toEqual({ OPENAI_API_KEY: OTHER });
  const owned = await f.service.apply({ ...delivery, revision: 2, overwrite: ["OPENAI_API_KEY"] });
  expect(owned.conflicts).toEqual([]);
  expect(f.state.env).toEqual({ OPENAI_API_KEY: KEY });
  // Once delivered, later canonical changes replace the delivered value without a conflict.
  const rotated = await f.service.apply({
    ...delivery,
    revision: 3,
    values: { OPENAI_API_KEY: OTHER },
  });
  expect(rotated.conflicts).toEqual([]);
  expect(f.state.env).toEqual({ OPENAI_API_KEY: OTHER });
});

test("rejects stale generations, unauthorized values and missing bindings", async () => {
  const f = fixture();
  await f.service.apply({ ...delivery, revision: 3 });
  await expect(f.service.apply(delivery)).rejects.toThrow("synchronization is pending");
  f.state.authorized = false;
  await expect(f.service.apply({ ...delivery, revision: 4 })).rejects.toThrow();
  const missing = fixture(null);
  await expect(missing.service.apply(delivery)).rejects.toThrow();
  // Withdrawal from a binding that no longer exists succeeds without writing.
  await expect(missing.service.apply({ ...delivery, values: {} })).resolves.toMatchObject({
    phase: "applied",
  });
  expect(missing.state.writes).toBe(0);
});

test("refuses names that are not secrets", async () => {
  const f = fixture();
  await expect(
    f.service.apply({ ...delivery, values: { CODEX_HOME: "/elsewhere" } }),
  ).rejects.toThrow();
  expect(f.state.writes).toBe(0);
});

test("speech delivery protects changed local values, applies owner clears and rejects cross-scope fields", async () => {
  let env: Record<string, string> = { apiKey: "local-key", baseUrl: "https://local.example/v1" };
  let journal: import("./provider-secrets-delivery.js").ProviderSecretsJournal | null = null;
  const service = new ProviderSecretsDeliveryService({
    read: () => journal,
    persist: (value) => {
      journal = value;
    },
    readEnv: () => env,
    writeEnv: (value) => {
      env = value;
    },
    authorize: async () => {},
  });
  const input = {
    kind: "speech" as const,
    installationId: "11111111-1111-4111-8111-111111111111",
    serverId: "dev",
    definitionId: "dictation.stt",
    providerId: "dictation.stt",
    policyRevision: 1,
    revision: 1,
    values: { apiKey: KEY, baseUrl: "https://shared.example/v1" },
    overwrite: [] as string[],
  };
  expect((await service.apply(input)).conflicts).toEqual(["apiKey", "baseUrl"]);
  expect(env.apiKey).toBe("local-key");
  // Resolving just the key still leaves the pair untouched while the endpoint conflicts.
  await service.apply({ ...input, revision: 2, overwrite: ["apiKey"] });
  expect(env.apiKey).toBe("local-key");
  await service.apply({ ...input, revision: 3, overwrite: ["apiKey", "baseUrl"] });
  expect(env.apiKey).toBe(KEY);
  expect(JSON.stringify(journal)).not.toContain(KEY);
  await service.apply({ ...input, revision: 4, values: {}, overwrite: ["apiKey", "baseUrl"] });
  expect(env).toEqual({});
  await expect(service.apply({ ...input, kind: undefined })).rejects.toThrow(
    "Provider key synchronization",
  );
  await expect(service.apply({ ...input, revision: 2 })).rejects.toThrow(
    "Provider key synchronization",
  );
  await expect(
    service.apply({ ...input, revision: 4, values: { OPENAI_API_KEY: KEY } }),
  ).rejects.toThrow("Provider key synchronization");
});

test("empty and withheld speech deliveries never write local values", async () => {
  let env = { apiKey: "synthetic-local-key", baseUrl: "https://local.example/v1" };
  let writes = 0;
  let journal: import("./provider-secrets-delivery.js").ProviderSecretsJournal | null = null;
  let released = false;
  const service = new ProviderSecretsDeliveryService({
    read: () => journal,
    persist: (value) => {
      journal = value;
    },
    readEnv: () => env,
    writeEnv: (value) => {
      writes += 1;
      env = value as typeof env;
    },
    release: () => {
      released = true;
    },
    authorize: async () => {},
  });
  const input = {
    ...delivery,
    kind: "speech",
    definitionId: "dictation.stt",
    providerId: "dictation.stt",
    values: {},
    overwrite: [],
  };
  await service.apply(input);
  expect(writes).toBe(0);
  expect(released).toBe(false);
  const result = await service.apply({
    ...input,
    revision: 2,
    values: { apiKey: KEY, baseUrl: "https://shared.example/v1" },
  });
  expect(result.conflicts).toEqual(["apiKey", "baseUrl"]);
  expect(writes).toBe(0);
  await service.apply({
    ...input,
    revision: 3,
    values: { apiKey: KEY, baseUrl: "https://shared.example/v1" },
    overwrite: ["apiKey", "baseUrl"],
  });
  expect(writes).toBe(1);
  await service.apply({ ...input, revision: 4 });
  expect(writes).toBe(1);
  expect(released).toBe(true);
});
