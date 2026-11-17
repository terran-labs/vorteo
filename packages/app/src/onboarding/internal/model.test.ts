import { PrimaryConnectionUnavailableError } from "@/execution-installation/primary-connection-error";
import type { InstallationSettingsSnapshot } from "@getpaseo/protocol/installation-settings";
import { describe, expect, it, vi } from "vitest";
import {
  createVorteoGuide,
  guidePrimaryConnectionChoice,
  type GuideHost,
  type GuidePrimaryConnectionRequest,
  type GuideRecord,
  type GuideStorage,
} from "../vorteo-guide/model";
import {
  createOnboardingModel,
  type OnboardingCompletionStorage,
  type OnboardingModel,
  type OnboardingSetupHost,
} from "./model";

class MemoryCompletionStorage implements OnboardingCompletionStorage {
  completed: boolean;

  constructor(completed = false) {
    this.completed = completed;
  }

  async isCompleted(): Promise<boolean> {
    return this.completed;
  }

  async markCompleted(): Promise<void> {
    this.completed = true;
  }
}

const FRESH_HOST: OnboardingSetupHost = {
  serverId: "local",
  isConnected: true,
  hasHydratedWorkspaces: true,
  hasProjects: false,
};

/** Presses Continue on whatever step is showing. */
function advance(model: OnboardingModel) {
  const state = model.getState();
  if (state.status !== "open") throw new Error("setup is not open");
  model.next(state.visit);
}

function currentVisit(model: OnboardingModel): number {
  const state = model.getState();
  if (state.status !== "open") throw new Error("setup is not open");
  return state.visit;
}

async function openModel(storage = new MemoryCompletionStorage()) {
  const model = createOnboardingModel({ storage });
  await model.ready;
  return model;
}

describe("onboarding model", () => {
  it("opens on the appearance step for a connected host with no projects", async () => {
    const model = await openModel();

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });

    expect(model.getState()).toMatchObject({
      status: "open",
      serverId: "local",
      steps: ["appearance", "providers", "projects", "orchestration", "phone"],
      stepIndex: 0,
    });
  });

  it("waits until the host is connected and its workspaces are hydrated", async () => {
    const model = await openModel();

    model.applySetupHost(null, { includePhoneStep: true });
    model.applySetupHost({ ...FRESH_HOST, isConnected: false }, { includePhoneStep: true });
    model.applySetupHost(
      { ...FRESH_HOST, hasHydratedWorkspaces: false },
      { includePhoneStep: true },
    );
    expect(model.getState()).toEqual({ status: "deciding" });

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    expect(model.getState().status).toBe("open");
  });

  it("stays hidden for a host that already has projects, even after they are removed", async () => {
    const model = await openModel();

    model.applySetupHost({ ...FRESH_HOST, hasProjects: true }, { includePhoneStep: true });
    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });

    expect(model.getState()).toEqual({ status: "hidden" });
  });

  it("stays hidden once setup was completed on this client", async () => {
    const model = await openModel(new MemoryCompletionStorage(true));

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });

    expect(model.getState()).toEqual({ status: "hidden" });
  });

  it("decides only after the completion record has loaded", async () => {
    const model = createOnboardingModel({ storage: new MemoryCompletionStorage(true) });

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    expect(model.getState()).toEqual({ status: "deciding" });

    await model.ready;
    expect(model.getState()).toEqual({ status: "hidden" });
  });

  it("keeps the modal open when the host gains its first project during setup", async () => {
    const model = await openModel();
    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    advance(model);
    advance(model);

    model.applySetupHost({ ...FRESH_HOST, hasProjects: true }, { includePhoneStep: true });

    expect(model.getState()).toMatchObject({ status: "open", stepIndex: 2 });
  });

  it("omits the phone step when the client is a phone", async () => {
    const model = await openModel();

    model.applySetupHost(FRESH_HOST, { includePhoneStep: false });

    expect(model.getState()).toMatchObject({
      steps: ["appearance", "providers", "projects", "orchestration"],
    });
  });

  it("moves between steps without leaving the step list", async () => {
    const model = await openModel();
    model.applySetupHost(FRESH_HOST, { includePhoneStep: false });

    model.back();
    expect(model.getState()).toMatchObject({ stepIndex: 0 });
    advance(model);
    advance(model);
    advance(model);
    expect(model.getState()).toMatchObject({ stepIndex: 3 });
    model.goTo("providers");
    expect(model.getState()).toMatchObject({ stepIndex: 1 });
    model.back();
    expect(model.getState()).toMatchObject({ stepIndex: 0 });
  });

  it("ignores a late advance from a step visit the user already left", async () => {
    const model = await openModel(new MemoryCompletionStorage(true));
    model.reopen("local", { includePhoneStep: true });
    model.goTo("projects");

    // Projects are still being added when the user leaves Projects and comes back.
    const addingFrom = currentVisit(model);
    model.goTo("appearance");
    model.goTo("projects");
    model.next(addingFrom);
    expect(model.getState()).toMatchObject({ stepIndex: 2 });

    // Or closes setup, opens it again and returns to Projects before the add finishes.
    await model.complete();
    model.reopen("local", { includePhoneStep: true });
    model.goTo("projects");
    model.next(addingFrom);
    expect(model.getState()).toMatchObject({ status: "open", stepIndex: 2 });
  });

  it("moving on from the last step finishes setup, unless the user left that step first", async () => {
    const storage = new MemoryCompletionStorage();
    const model = await openModel(storage);
    model.applySetupHost(FRESH_HOST, { includePhoneStep: false });
    model.goTo("orchestration");

    // Finish is applying choices when the user goes back to Projects.
    const finishingFrom = currentVisit(model);
    model.back();
    model.next(finishingFrom);
    expect(model.getState()).toMatchObject({ status: "open", stepIndex: 2 });
    expect(storage.completed).toBe(false);

    advance(model);
    advance(model);
    await vi.waitFor(() => expect(storage.completed).toBe(true));
    expect(model.getState()).toEqual({ status: "hidden" });
  });

  it("records completion when setup closes, so it does not open again", async () => {
    const storage = new MemoryCompletionStorage();
    const model = await openModel(storage);
    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });

    await model.complete();

    expect(model.getState()).toEqual({ status: "hidden" });
    expect(storage.completed).toBe(true);
    const relaunched = await openModel(storage);
    relaunched.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    expect(relaunched.getState()).toEqual({ status: "hidden" });
  });

  it("reopens on the first step for an existing user", async () => {
    const model = await openModel(new MemoryCompletionStorage(true));
    model.applySetupHost({ ...FRESH_HOST, hasProjects: true }, { includePhoneStep: true });

    model.reopen("local", { includePhoneStep: true });

    expect(model.getState()).toMatchObject({ status: "open", serverId: "local", stepIndex: 0 });
  });

  it("notifies subscribers on every state change", async () => {
    const model = await openModel();
    const seen: string[] = [];
    model.subscribe(() => {
      const state = model.getState();
      seen.push(state.status === "open" ? `open:${state.stepIndex}` : state.status);
    });

    model.applySetupHost(FRESH_HOST, { includePhoneStep: true });
    advance(model);
    await model.complete();

    expect(seen).toEqual(["open:0", "open:1", "hidden"]);
  });
});

class InstallationGuideStorage implements GuideStorage {
  records = new Map<string, GuideRecord>();
  async read(id: string) {
    return this.records.get(id) ?? null;
  }
  async write(id: string, record: GuideRecord) {
    this.records.set(id, record);
  }
}

const GUIDE_HOST: GuideHost = {
  installationId: "one",
  serverId: "host",
  ownerAuthenticated: true,
  isConnected: true,
  hasHydratedWorkspaces: true,
  hasUserProjects: false,
  supportsPrimaryConnection: true,
};

describe("Vorteo authenticated setup", () => {
  it("waits for the authenticated installation and hydrated directory", async () => {
    const model = createVorteoGuide({
      savePrimaryConnection: async () => {},
      installationId: "one",
      storage: new InstallationGuideStorage(),
    });
    await model.ready;
    model.applyGate({ ...GUIDE_HOST, ownerAuthenticated: false });
    model.reopen({ ...GUIDE_HOST, installationId: "other" });
    model.applyGate({ ...GUIDE_HOST, hasHydratedWorkspaces: false });
    expect(model.getState()).toEqual({ status: "deciding" });
    model.applyGate(GUIDE_HOST);
    expect(model.getState()).toMatchObject({ status: "open", serverId: "host" });
  });

  it("isolates installations and records Skip separately from Finish", async () => {
    const storage = new InstallationGuideStorage();
    const one = createVorteoGuide({
      savePrimaryConnection: async () => {},
      installationId: "one",
      storage,
    });
    await one.ready;
    one.applyGate(GUIDE_HOST);
    await one.skip();
    const two = createVorteoGuide({
      savePrimaryConnection: async () => {},
      installationId: "two",
      storage,
    });
    const restored = createVorteoGuide({
      savePrimaryConnection: async () => {},
      installationId: "one",
      storage,
    });
    await Promise.all([two.ready, restored.ready]);
    restored.applyGate(GUIDE_HOST);
    two.applyGate({ ...GUIDE_HOST, installationId: "two" });
    expect(restored.getState()).toEqual({ status: "hidden" });
    expect(two.getState()).toMatchObject({ status: "open" });
    await two.complete();
    expect(storage.records.get("one")?.disposition).toBe("skipped");
    expect(storage.records.get("two")?.disposition).toBe("completed");
  });

  it("resumes where the owner left for Settings and rejects a stale completion", async () => {
    const storage = new InstallationGuideStorage();
    const model = createVorteoGuide({
      savePrimaryConnection: async () => {},
      installationId: "one",
      storage,
    });
    await model.ready;
    model.applyGate(GUIDE_HOST);
    model.goTo("providers");
    const state = model.getState();
    if (state.status !== "open") throw new Error("Expected open guide");
    await model.pause();
    // Visiting Settings is neither Skip nor Finish, but it keeps the step.
    expect(storage.records.get("one")).toMatchObject({ disposition: "paused", step: "providers" });
    model.reopen(GUIDE_HOST);
    model.next(state.visit);
    expect(model.getState()).toMatchObject({ status: "open", stepIndex: 1 });

    // After a reload the paused guide stays closed until reopened, then resumes at its step.
    const reloaded = createVorteoGuide({
      savePrimaryConnection: async () => {},
      installationId: "one",
      storage,
    });
    await reloaded.ready;
    reloaded.applyGate(GUIDE_HOST);
    expect(reloaded.getState()).toEqual({ status: "hidden" });
    reloaded.reopen(GUIDE_HOST);
    expect(reloaded.getState()).toMatchObject({ status: "open", stepIndex: 1 });
    await reloaded.complete();
    expect(storage.records.get("one")?.disposition).toBe("completed");
  });
});

describe("Vorteo primary connection", () => {
  it("keeps unsupported choices local and maps supported writes to definition identity", async () => {
    const saved: string[] = [];
    let removed = false;
    const savePrimaryConnection = vi.fn(async (request: GuidePrimaryConnectionRequest) => {
      const snapshot: InstallationSettingsSnapshot = {
        version: 1,
        revision: 1,
        sources: {},
        settings: {
          mcp: { injectIntoAgents: true },
          appendSystemPrompt: "",
          autoArchiveAfterMerge: false,
          enableTerminalAgentHooks: false,
          metadataGeneration: { providers: [] },
          pluginsEnabled: false,
          terminalProfiles: [],
          resourceExclusions: {},
          providerDefinitions: [
            {
              id: "managed/definition",
              providerType: "claude",
              removed,
              bindings: { host: "claude-account-runtime" },
              policy: { label: "A different label", enabled: true },
            },
          ],
        },
      };
      const choice = guidePrimaryConnectionChoice(snapshot, request);
      if (!choice)
        throw new Error("This connection is no longer available in installation settings.");
      saved.push(choice.providerId);
    });
    const model = createVorteoGuide({
      installationId: "one",
      storage: new InstallationGuideStorage(),
      savePrimaryConnection,
    });
    await model.ready;
    model.applyGate({ ...GUIDE_HOST, supportsPrimaryConnection: false });
    model.goTo("providers");
    const state = model.getState();
    if (state.status !== "open") throw new Error("Expected open guide");
    expect(await model.recordPrimaryConnection("claude-account-runtime", state.visit)).toBe(
      "local",
    );
    expect(model.primaryRuntimeProviderId).toBe("claude-account-runtime");
    expect(savePrimaryConnection).not.toHaveBeenCalled();
    model.applyGate(GUIDE_HOST);
    expect(await model.recordPrimaryConnection("claude-account-runtime", state.visit)).toBe(
      "saved",
    );
    expect(saved).toEqual(["managed/definition"]);
    expect(savePrimaryConnection).toHaveBeenCalledExactlyOnceWith({
      serverId: "host",
      runtimeProviderId: "claude-account-runtime",
    });
    expect(
      guidePrimaryConnectionChoice(
        { version: 1, revision: 0, sources: {}, settings: null },
        {
          serverId: "host",
          runtimeProviderId: "A different label",
        },
      ),
    ).toBeNull();
    removed = true;
    await expect(
      model.recordPrimaryConnection("claude-account-runtime", state.visit),
    ).rejects.toThrow("no longer available");
    expect(saved).toEqual(["managed/definition"]);
    expect(model.getState()).toMatchObject({ stepIndex: 1, visit: state.visit });
    model.next(state.visit);
    expect(await model.recordPrimaryConnection("claude-account-runtime", state.visit)).toBe(
      "stale",
    );
    expect(savePrimaryConnection).toHaveBeenCalledTimes(2);
  });

  it("delegates retry to Settings, maps unavailable errors and ignores late completion", async () => {
    const conflict = new Error(
      "Shared settings changed. Reload and review the current values before saving.",
    );
    const savePrimaryConnection = vi.fn(
      async (_request: { serverId: string; runtimeProviderId: string }) => {},
    );
    const model = createVorteoGuide({
      installationId: "one",
      storage: new InstallationGuideStorage(),
      savePrimaryConnection,
    });
    await model.ready;
    model.applyGate(GUIDE_HOST);
    model.goTo("providers");
    const state = model.getState();
    if (state.status !== "open") throw new Error("Expected open guide");
    savePrimaryConnection.mockRejectedValueOnce(conflict);
    await expect(model.recordPrimaryConnection("codex", state.visit)).rejects.toBe(conflict);
    expect(savePrimaryConnection).toHaveBeenCalledTimes(1);
    expect(model.getState()).toMatchObject({ visit: state.visit, stepIndex: 1 });
    savePrimaryConnection.mockClear();
    savePrimaryConnection.mockRejectedValueOnce(new PrimaryConnectionUnavailableError());
    await expect(model.recordPrimaryConnection("codex", state.visit)).rejects.toThrow(
      "This connection is no longer available in installation settings. Refresh and choose again.",
    );
    expect(savePrimaryConnection).toHaveBeenCalledTimes(1);
    expect(model.getState()).toMatchObject({ visit: state.visit, stepIndex: 1 });
    savePrimaryConnection.mockClear();
    savePrimaryConnection.mockRejectedValueOnce(new Error("Unlock installation controls"));
    await expect(model.recordPrimaryConnection("codex", state.visit)).rejects.toThrow("Unlock");
    expect(savePrimaryConnection).toHaveBeenCalledTimes(1);
    let finish!: () => void;
    savePrimaryConnection.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = model.recordPrimaryConnection("codex", state.visit);
    model.goTo("projects");
    finish();
    expect(await pending).toBe("stale");
    expect(model.getState()).toMatchObject({ stepIndex: 2 });
  });
});
