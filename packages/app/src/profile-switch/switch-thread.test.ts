import { describe, expect, it, vi } from "vitest";
import { offersStopTurn, switchThreadProfile } from "./switch-thread";

const target = { provider: "codex-two", profileId: "other", reason: "quota" as const };

function client() {
  return {
    cancelAgent: vi.fn().mockResolvedValue(undefined),
    switchAgentProfile: vi.fn().mockResolvedValue(undefined),
  };
}

describe("switching a thread's account", () => {
  it("waits for the stop to settle before reading the target and switching", async () => {
    const api = client();
    let settle!: () => void;
    api.cancelAgent.mockReturnValue(new Promise<void>((resolve) => (settle = resolve)));
    const readTarget = vi.fn(() => target);
    const onStage = vi.fn();
    const switching = switchThreadProfile(api, "agent", readTarget, { stopTurn: true, onStage });
    await Promise.resolve();
    expect(api.cancelAgent).toHaveBeenCalledWith("agent");
    expect(readTarget).not.toHaveBeenCalled();
    expect(onStage).not.toHaveBeenCalled();
    expect(api.switchAgentProfile).not.toHaveBeenCalled();
    settle();
    await switching;
    expect(onStage).toHaveBeenCalledWith("switching");
    expect(api.switchAgentProfile).toHaveBeenCalledWith("agent", target);
    expect(onStage.mock.invocationCallOrder[0]).toBeLessThan(
      api.switchAgentProfile.mock.invocationCallOrder[0],
    );
  });

  it("does not switch or advance the stage when the stop is refused", async () => {
    const api = client();
    api.cancelAgent.mockRejectedValue(new Error("The turn could not be stopped."));
    const readTarget = vi.fn(() => target);
    const onStage = vi.fn();
    await expect(
      switchThreadProfile(api, "agent", readTarget, { stopTurn: true, onStage }),
    ).rejects.toThrow("The turn could not be stopped.");
    expect(readTarget).not.toHaveBeenCalled();
    expect(onStage).not.toHaveBeenCalled();
    expect(api.switchAgentProfile).not.toHaveBeenCalled();
  });

  it("switches an idle thread without stopping it and surfaces the daemon's refusal", async () => {
    const api = client();
    api.switchAgentProfile.mockRejectedValue(new Error("Wait for the current turn."));
    const onStage = vi.fn();
    await expect(
      switchThreadProfile(api, "agent", () => target, { stopTurn: false, onStage }),
    ).rejects.toThrow("Wait for the current turn.");
    expect(api.cancelAgent).not.toHaveBeenCalled();
    expect(onStage).not.toHaveBeenCalled();
    expect(api.switchAgentProfile).toHaveBeenCalledWith("agent", target);
  });

  it("offers to stop only a running turn, not a leftover permission request", () => {
    expect(offersStopTurn({ status: "running" })).toBe(true);
    const permissionOnly = { status: "idle", pendingPermissions: [{ id: "permission" }] };
    expect(offersStopTurn(permissionOnly)).toBe(false);
    expect(offersStopTurn(null)).toBe(false);
  });
});
