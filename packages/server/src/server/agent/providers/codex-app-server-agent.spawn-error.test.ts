import { describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderProbeCwd } from "../../../utils/provider-probe-cwd.js";

import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { runProviderRefreshWithDeadline } from "../provider-refresh-deadline.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createCodexAppServerChildProcess } from "./codex/test-utils/fake-app-server.js";

describe("CodexAppServerAgentClient spawn error handling", () => {
  const logger = createTestLogger();

  test("isolates app-server process cwd while preserving thread workspace cwd", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "codex-process-cwd-")));
    const script = join(workspace, "fake-codex.cjs");
    const receipt = join(workspace, "cwd.json");
    await writeFile(
      script,
      `
      const fs = require('node:fs');
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result = { data: [] };
        if (request.method === 'model/list') result = { data: [{ id: 'gpt-5.4', isDefault: true, defaultReasoningEffort: 'medium' }] };
        if (request.method === 'config/read') result = { config: {} };
        if (request.method === 'thread/start') {
          fs.writeFileSync(process.argv[2], JSON.stringify({ processCwd: process.cwd(), threadCwd: request.params.cwd }));
          result = { thread: { id: 'isolated-thread' } };
        }
        if (request.method === 'turn/start') result = { turn: { id: 'isolated-turn' } };
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
      });
    `,
    );
    const client = new CodexAppServerAgentClient(logger, {
      command: { mode: "replace", argv: [process.execPath, script, receipt] },
    });
    let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
    try {
      session = await client.createSession({ provider: "codex", cwd: workspace });
      await session.startTurn("Fixture prompt");
      const observed: unknown = JSON.parse(await readFile(receipt, "utf8"));
      expect(observed).toEqual({
        processCwd: await realpath(await getProviderProbeCwd()),
        threadCwd: workspace,
      });
      expect(await realpath(await getProviderProbeCwd())).not.toBe(workspace);
    } finally {
      await session?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("fetchCatalog rejects gracefully when the codex binary does not exist", async () => {
    const client = new CodexAppServerAgentClient(logger, {
      command: {
        mode: "replace",
        argv: ["/nonexistent/codex-binary-that-does-not-exist"],
      },
    });

    const uncaughtErrors: unknown[] = [];
    const onUncaught = (err: unknown) => {
      uncaughtErrors.push(err);
    };
    process.on("uncaughtException", onUncaught);

    try {
      await expect(
        client.fetchCatalog({ scope: "workspace", cwd: "/tmp/codex-models", force: false }),
      ).rejects.toThrow();
      // Drain microtask queue to ensure no deferred uncaught errors
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaughtErrors).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  test("fetchCatalog settles when the refresh deadline aborts an unanswered initialize", async () => {
    const client = new CodexAppServerAgentClient(logger, {
      command: {
        mode: "replace",
        argv: ["/nonexistent/codex-binary-that-does-not-exist"],
      },
    });
    const child = createCodexAppServerChildProcess();
    const kill = vi.spyOn(child, "kill");
    Object.assign(client, { spawnAppServer: async () => child });

    await expect(
      runProviderRefreshWithDeadline({
        label: "Codex",
        timeoutMs: 50,
        operation: (context) =>
          client.fetchCatalog(
            { scope: "workspace", cwd: "/tmp/codex-models", force: false },
            context,
          ),
      }),
    ).rejects.toThrow("Timed out refreshing Codex after 50ms");
    expect(kill).toHaveBeenCalled();
  });

  test("listImportableSessions rejects gracefully when the codex binary does not exist", async () => {
    const client = new CodexAppServerAgentClient(logger, {
      command: {
        mode: "replace",
        argv: ["/nonexistent/codex-binary-that-does-not-exist"],
      },
    });

    const uncaughtErrors: unknown[] = [];
    const onUncaught = (err: unknown) => {
      uncaughtErrors.push(err);
    };
    process.on("uncaughtException", onUncaught);

    try {
      await expect(client.listImportableSessions()).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaughtErrors).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
