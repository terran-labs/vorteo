import { compileFunction } from "node:vm";
import type { BrowserContext } from "@playwright/test";
import { expect, it } from "vitest";
import { createVorteoGuide } from "./model";
import { createGuideStorage, guideStorageKey } from "./storage";
import {
  completeInstallationSetupGuide,
  seedInstallationSetupGuide,
  type InstallationGuideEnvironment,
} from "../../../e2e/support/helpers/installation-setup-guide";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  readonly entries = new Map<string, string>();
  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }
  removeItem(key: string) {
    this.entries.delete(key);
  }
  setItem(key: string, value: string) {
    this.entries.set(key, value);
  }
}

it("seeds completion through explicit adapters and the serialized browser registration", async () => {
  const scripts: string[] = [];
  const context: Pick<BrowserContext, "addInitScript"> = {
    async addInitScript(script) {
      if (typeof script !== "string") throw new TypeError("Expected serialized init source");
      scripts.push(script);
    },
  };
  const installationId = "fixture/installation with spaces";
  const origin = "https://installation.example";
  const storage = new MemoryStorage();
  const guideStorage = createGuideStorage({
    getItem: async (key) => storage.getItem(key),
    setItem: async (key, value) => storage.setItem(key, value),
    removeItem: async (key) => storage.removeItem(key),
  });
  const environment: InstallationGuideEnvironment = { origin, isTopLevel: true, storage };
  const seed = { origin, key: guideStorageKey(installationId) };
  storage.setItem("unrelated", "preserve me");

  await expect(
    completeInstallationSetupGuide(context, { installationId: " ", origin }),
  ).rejects.toThrow(TypeError);
  expect(scripts).toHaveLength(0);
  await completeInstallationSetupGuide(context, { installationId, origin: `${origin}/setup` });
  expect(scripts).toHaveLength(1);
  // Supply window as a lexical function argument, never as a patched global.
  // Only the registered helper source is compiled; product modules use their real imports.
  const registered = compileFunction(scripts[0], ["window"]);
  function executeRegistration(documentEnvironment: InstallationGuideEnvironment) {
    const browserAdapter = {
      location: { origin: documentEnvironment.origin },
      get top(): object {
        return documentEnvironment.isTopLevel ? browserAdapter : {};
      },
      localStorage: documentEnvironment.storage,
    };
    registered(browserAdapter);
  }

  for (const execute of [
    (documentEnvironment: InstallationGuideEnvironment) =>
      seedInstallationSetupGuide(documentEnvironment, seed),
    executeRegistration,
  ]) {
    storage.removeItem(seed.key);
    execute({ ...environment, origin: "https://other.example" });
    execute({ ...environment, isTopLevel: false });
    expect([...storage.entries]).toEqual([["unrelated", "preserve me"]]);
    execute(environment);

    const record = await guideStorage.read(installationId);
    expect(record).toEqual({ disposition: "completed", updatedAt: expect.any(String) });
    if (!record) throw new Error("Expected a completed guide record");
    expect(new Date(record.updatedAt).toISOString()).toBe(record.updatedAt);
    const original = storage.getItem(seed.key);
    execute(environment);
    expect(storage.getItem(seed.key)).toBe(original);
    expect(storage.getItem("unrelated")).toBe("preserve me");
    expect(storage.entries.size).toBe(2);

    for (const [id, status] of [
      [installationId, "hidden"],
      ["unseeded", "open"],
    ]) {
      const model = createVorteoGuide({
        installationId: id,
        storage: guideStorage,
        savePrimaryConnection: async () => {},
      });
      await model.ready;
      model.applyGate({
        installationId: id,
        serverId: "host",
        ownerAuthenticated: true,
        isConnected: true,
        hasHydratedWorkspaces: true,
        hasUserProjects: false,
        supportsPrimaryConnection: true,
      });
      expect(model.getState().status).toBe(status);
    }
    expect(await guideStorage.read("unseeded")).toBeNull();

    storage.setItem(seed.key, "");
    execute(environment);
    expect(storage.getItem(seed.key)).toBe("");
    expect(await guideStorage.read(installationId)).toBeNull();
    expect(storage.getItem(seed.key)).toBeNull();
    await guideStorage.write(installationId, record);
    expect(await guideStorage.read(installationId)).toEqual(record);

    const failure = new Error("Storage write denied");
    const failingStorage: InstallationGuideEnvironment["storage"] = {
      getItem: () => null,
      setItem: () => {
        throw failure;
      },
    };
    expect(() => execute({ ...environment, storage: failingStorage })).toThrow(failure);
  }
});
