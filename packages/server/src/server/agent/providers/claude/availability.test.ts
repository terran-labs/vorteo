import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { discoverClaudeModels, forgetClaudeModelDiscoveries } from "./model-discovery.js";
import { ClaudeAgentClient } from "./agent.js";

const directories: string[] = [];
afterEach(async () => {
  forgetClaudeModelDiscoveries();
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

it.each(["version", "models"])(
  "shutdown waits for an active catalog %s child after availability succeeded",
  async (stage) => {
    const directory = await mkdtemp(join(tmpdir(), "claude-catalog-stop-"));
    directories.push(directory);
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const script = join(directory, "cli.cjs");
    const writes = join(directory, "writes");
    await writeFile(writes, "");
    await writeFile(
      script,
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2).join(' ');
      if (args === 'auth status') {
        process.stdout.write(JSON.stringify({loggedIn: true}));
        process.exit(0);
      }
      if (args === '--version' && ${JSON.stringify(stage)} === 'models') {
        process.stdout.write('2.1.100 (Claude Code)');
        process.exit(0);
      }
      fs.appendFileSync(${JSON.stringify(writes)}, args + ${JSON.stringify("\n")});
      const socket = require('node:net').connect(${address.port}, '127.0.0.1');
      socket.on('connect', () => socket.write(String(process.pid)));
      socket.on('data', () => fs.appendFileSync(${JSON.stringify(writes)}, 'late write'));
    `,
    );
    const activities: string[] = [];
    const controller = new AbortController();
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: { HOME: directory, CLAUDE_CONFIG_DIR: directory },
      },
      resolveBinary: async () => script,
      discoverModels: (options) =>
        discoverClaudeModels(options, (_input, context) => {
          const child = spawn(process.execPath, [script, "models"], {
            env: { ...process.env, HOME: directory, CLAUDE_CONFIG_DIR: directory },
            stdio: "ignore",
          });
          context.onChildProcess?.(child);
          return { supportedModels: () => new Promise(() => {}), close: () => {} };
        }),
    });
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => sockets.add(socket));
    onTestFinished(async () => {
      await client.shutdown();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await expect(client.isAvailable()).resolves.toBe(true);
    const connected = once(server, "connection", { signal: AbortSignal.timeout(3_000) });
    // Exercise both calls without a refresh context and normal activity reporting.
    const context =
      stage === "version"
        ? undefined
        : {
            signal: controller.signal,
            runActivity: async <T>(name: string, operation: () => Promise<T>) => {
              activities.push(name);
              return operation();
            },
          };
    const refresh = client
      .fetchCatalog({ scope: "global", force: true }, context)
      .catch((error: unknown) => error);
    const [socket] = await connected;
    const pid = Number(String((await once(socket, "data"))[0]));
    await client.shutdown();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await refresh).toMatchObject({ name: "AbortError" });
    expect(activities).toEqual(stage === "models" ? ["version", "models"] : []);
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await readFile(writes, "utf8")).toBe(stage === "version" ? "--version\n" : "models\n");
  },
);

it("shutdown during version resolution prevents all catalog children", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-catalog-resolving-"));
  directories.push(directory);
  const script = join(directory, "cli.cjs");
  const writes = join(directory, "writes");
  await writeFile(writes, "");
  await writeFile(
    script,
    `require('node:fs').appendFileSync(${JSON.stringify(writes)}, 'launched');`,
  );
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { HOME: directory, CLAUDE_CONFIG_DIR: directory },
    },
    discoverModels: async () => {
      throw new Error("Discovery must not start");
    },
  });
  const refresh = client
    .fetchCatalog({ scope: "global", force: true })
    .catch((error: unknown) => error);
  await client.shutdown();
  expect(await refresh).toMatchObject({ name: "AbortError" });
  expect(await readFile(writes, "utf8")).toBe("");
});

it.each(["shutdown", "caller"])(
  "%s cancellation prevents discovery after binary resolution",
  async (owner) => {
    const directory = await mkdtemp(join(tmpdir(), "claude-catalog-cancel-"));
    directories.push(directory);
    let resolveBinary!: (binary: string) => void;
    let resolving!: () => void;
    const started = new Promise<void>((resolve) => {
      resolving = resolve;
    });
    const binary = new Promise<string>((resolve) => {
      resolveBinary = resolve;
    });
    const controller = new AbortController();
    const activities: string[] = [];
    let launches = 0;
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { HOME: directory, CLAUDE_CONFIG_DIR: directory } },
      resolveVersion: async () => "2.1.100",
      resolveBinary: () => {
        resolving();
        return binary;
      },
      discoverModels: (options) =>
        discoverClaudeModels(options, () => {
          launches++;
          return { supportedModels: async () => [], close: () => {} };
        }),
    });
    const refresh = client
      .fetchCatalog(
        {},
        {
          signal: controller.signal,
          runActivity: async <T>(name: string, operation: () => Promise<T>) => {
            activities.push(name);
            return operation();
          },
        },
      )
      .catch((error: unknown) => error);
    await started;
    if (owner === "shutdown") await client.shutdown();
    else controller.abort();
    resolveBinary("/fake-claude");
    expect(await refresh).toMatchObject({ name: "AbortError" });
    expect(launches).toBe(0);
    expect(activities).toEqual(["version", "models"]);
    await client.shutdown();
  },
);

it.each([
  ["expired", 1, false],
  ["far from expiry", Date.now() + 6 * 60 * 60_000, true],
])(
  "the diagnostic runs `auth status` for a full sign-in only away from its renewal: %s",
  async (_name, expiresAt, runsAuthStatus) => {
    const directory = await mkdtemp(join(tmpdir(), "claude-diagnostic-"));
    directories.push(directory);
    const script = join(directory, "cli.cjs");
    const calls = join(directory, "calls");
    await writeFile(calls, "");
    await writeFile(
      script,
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2).join(' ');
      fs.appendFileSync(${JSON.stringify(calls)}, args + ${JSON.stringify("\n")});
      if (args === '--version') process.stdout.write('2.1.321 (Claude Code)');
      if (args === 'auth status') process.stdout.write(JSON.stringify({ loggedIn: true }));
      `,
    );
    // Synthetic stored sign-in: the CLI's own file format, never a real credential.
    await writeFile(
      join(directory, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "synthetic-access",
          refreshToken: "synthetic-refresh",
          expiresAt,
          scopes: [],
        },
      }),
      { mode: 0o600 },
    );
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: { HOME: directory, CLAUDE_CONFIG_DIR: directory, VORTEO_CLAUDE_SIGN_IN: "full" },
      },
      resolveBinary: async () => script,
    });
    try {
      const { diagnostic } = await client.getDiagnostic();
      const ran = (await readFile(calls, "utf8")).split("\n").includes("auth status");
      expect(ran).toBe(runsAuthStatus);
      expect(diagnostic.includes("Not checked")).toBe(!runsAuthStatus);
    } finally {
      await client.shutdown();
    }
  },
);
