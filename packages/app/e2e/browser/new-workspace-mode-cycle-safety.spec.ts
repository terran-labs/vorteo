import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test as base, type Page } from "../support/fixtures";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";

const test = base.extend({
  e2eDaemonEnvironment: [
    async ({ browserName }, provide) => {
      void browserName;
      const codexHome = await mkdtemp(path.join(tmpdir(), "mode-cycle-codex-"));
      try {
        await provide({ CODEX_HOME: codexHome });
      } finally {
        // The daemon depends on this worker fixture and stops before its state is removed.
        await rm(codexHome, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        codex: {
          enabled: true,
          command: [process.execPath, path.resolve("e2e/fixtures/catalog-codex.mjs")],
        },
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
      },
    },
  },
});

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";

type WebSocketMessage = string | Buffer;

function parseWebSocketJson(message: WebSocketMessage): unknown {
  const rawMessage = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseWebSocketJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

// The draft mode control in New Workspace only mutates local form state; it never sends
// set_agent_mode_request. So the only source of such a request while the New Workspace
// composer is focused is a *live* agent's mode control. Recording those, keyed by agentId,
// gives a direct signal that Shift+Tab leaked into a backgrounded agent.
async function recordSetAgentModeRequests(page: Page): Promise<{
  requestsForAgent(agentId: string): Array<{ agentId: string; modeId: string }>;
}> {
  const seen: Array<{ agentId: string; modeId: string }> = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "set_agent_mode_request") {
        const agentId = typeof sessionMessage.agentId === "string" ? sessionMessage.agentId : "";
        const modeId = typeof sessionMessage.modeId === "string" ? sessionMessage.modeId : "";
        seen.push({ agentId, modeId });
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      const payload = sessionMessage?.payload;
      if (
        sessionMessage?.type === "status" &&
        payload &&
        typeof payload === "object" &&
        "status" in payload &&
        payload.status === "server_info" &&
        "features" in payload &&
        payload.features &&
        typeof payload.features === "object"
      ) {
        // Exercise a legacy host's live mode control. Modern hosts replace it with
        // the profile picker after configuration loads, making that control transient.
        Object.assign(payload.features, { agentProfileLaunch: false });
        ws.send(JSON.stringify({ type: "session", message: sessionMessage }));
        return;
      }
      ws.send(message);
    });
  });
  return {
    requestsForAgent: (agentId: string) => seen.filter((request) => request.agentId === agentId),
  };
}

async function seedCodexDefaultPreferences(page: Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-6.1-sol",
              mode: "auto",
              thinkingByModel: { "gpt-6.1-sol": "medium" },
            },
            mock: { model: "ten-second-stream" },
          },
        } satisfies FormPreferences),
      );
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY },
  );
}

// Focus the New Workspace composer and cycle the execution mode with the keyboard.
// Kept out of the test body so the test reads as intent rather than key mechanics.
async function cycleNewWorkspaceMode(page: Page, presses: number): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.click();
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Shift+Tab");
  }
}

test.describe("New Workspace mode cycle safety on legacy hosts", () => {
  test.describe.configure({ timeout: 240_000 });

  // Regression guard for the P1 safety bug: cycling the execution mode with Shift+Tab in
  // the New Workspace composer must never reach a backgrounded, still-mounted agent's mode
  // control and silently change that (possibly running) agent's mode — e.g. into a
  // permissive/bypass mode. See use-keyboard-action-handler.ts.
  test("Shift+Tab in New Workspace never changes a backgrounded agent's mode", async ({ page }) => {
    const seeded = await seedWorkspace({ repoPrefix: "mode-cycle-safety-" });
    await seedCodexDefaultPreferences(page);
    const modeRequests = await recordSetAgentModeRequests(page);

    try {
      const agent = await seeded.client.createAgent({
        provider: "codex",
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title: "mode cycle safety e2e",
        modeId: "auto",
        model: "gpt-6.1-sol",
      });

      // Mount the live agent tab: its mode control registers a mode-cycle keyboard handler.
      await openAgentRoute(page, { workspaceId: seeded.workspaceId, agentId: agent.id });
      await expect(
        page.getByRole("button", { name: "Select agent mode (Default permissions)" }),
      ).toBeVisible({ timeout: 30_000 });

      // Move to the New Workspace composer. The agent tab stays mounted in the background,
      // so its handler is still registered when we cycle here.
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      });

      await cycleNewWorkspaceMode(page, 6);

      // fetchAgents is a real daemon round-trip; once it resolves, any mode change the
      // presses would have triggered has already landed. Assert the running agent is
      // untouched — both its committed mode and on the wire — with no fixed sleep.
      const agents = await seeded.client.fetchAgents();
      const backgroundAgent = agents.entries.find((entry) => entry.agent.id === agent.id)?.agent;
      expect(backgroundAgent?.currentModeId).toBe("auto");
      expect(modeRequests.requestsForAgent(agent.id)).toEqual([]);
    } finally {
      await seeded.cleanup();
    }
  });
});
