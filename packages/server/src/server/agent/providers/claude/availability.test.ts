import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("checks the configured process on every availability probe instead of caching executable presence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-availability-"));
  directories.push(directory);
  const script = join(directory, "cli.cjs");
  const state = join(directory, "authentication.json");
  await writeFile(
    script,
    `
    const fs = require('node:fs');
    if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(2);
    const status = JSON.parse(fs.readFileSync(process.env.TEST_AUTH_FILE, 'utf8'));
    process.stdout.write(JSON.stringify(status));
    process.exit(status.loggedIn ? 0 : 1);
  `,
  );
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { TEST_AUTH_FILE: state },
    },
  });
  await writeFile(state, JSON.stringify({ loggedIn: false }));
  await expect(client.isAvailable()).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
  await writeFile(state, JSON.stringify({ loggedIn: true }));
  await expect(client.isAvailable()).resolves.toBe(true);
  await writeFile(state, JSON.stringify({ loggedIn: false }));
  await expect(client.isAvailable()).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
});

it("keeps an absent executable distinct from a signed-out executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-missing-"));
  directories.push(directory);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { command: { mode: "replace", argv: [join(directory, "absent")] } },
  });
  await expect(client.isAvailable()).resolves.toBe(false);
});

it("shutdown ends availability writers and prevents later probes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-availability-stop-"));
  directories.push(directory);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const script = join(directory, "cli.cjs");
  await writeFile(
    script,
    `
    if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(2);
    const socket = require('node:net').connect(${address.port}, '127.0.0.1');
    socket.on('connect', () => socket.write(String(process.pid)));
  `,
  );
  const settings = {
    command: { mode: "replace" as const, argv: [process.execPath, script] },
    env: { CLAUDE_CONFIG_DIR: directory },
  };
  const client = new ClaudeAgentClient({ logger: createTestLogger(), runtimeSettings: settings });
  const connected = once(server, "connection");
  const probe = client.isAvailable().catch((error: unknown) => error);
  const [socket] = await connected;
  const pid = Number(String((await once(socket, "data"))[0]));
  try {
    await Promise.all([client.shutdown(), client.shutdown()]);
    expect(await probe).toMatchObject({ code: "CHECK_FAILED" });
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(client.isAvailable()).rejects.toMatchObject({ name: "AbortError" });

    // Shutdown while executable resolution is pending must not launch auth status afterward.
    const resolving = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: settings,
    });
    const earlyProbe = resolving.isAvailable().catch((error: unknown) => error);
    await resolving.shutdown();
    expect(await earlyProbe).toMatchObject({ name: "AbortError" });
  } finally {
    await client.shutdown();
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
