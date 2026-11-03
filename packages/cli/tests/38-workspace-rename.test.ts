#!/usr/bin/env npx tsx

import assert from "node:assert";
import { basename, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createPaseoClient } from "@getpaseo/client";
import { createTempDirs, runPaseoCli, startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Workspace Rename Command ===\n");

const fixtureDirs = await createTempDirs();
const authCommand = join(fixtureDirs.paseoHome, "connected-claude.cjs");
await writeFile(
  authCommand,
  `const command = process.argv.slice(2).join(" ");
if (command === "auth status") console.log(JSON.stringify({ loggedIn: true }));
else if (command === "--version") console.log("2.1.293 (Claude Code)");
else process.exit(1);`,
);
await writeFile(
  join(fixtureDirs.paseoHome, "config.json"),
  JSON.stringify({
    version: 1,
    agents: { providers: { claude: { command: [process.execPath, authCommand] } } },
  }),
);
const daemon = await startTestDaemon({ ...fixtureDirs, timeout: 30000 });
const ctx = {
  ...daemon,
  paseo: (args: string[], options?: Parameters<typeof runPaseoCli>[2]) =>
    runPaseoCli(daemon, args, options),
};

try {
  const created = await ctx.paseo([
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    ctx.workDir,
    "--title",
    "Original title",
    "--json",
  ]);
  assert.strictEqual(created.exitCode, 0, created.stderr);
  const workspaceId = JSON.parse(created.stdout).workspaceId as string;

  const renamed = await ctx.paseo(["workspace", "rename", workspaceId, "Auth rework", "--json"]);
  assert.strictEqual(renamed.exitCode, 0, renamed.stderr);
  assert.deepStrictEqual(JSON.parse(renamed.stdout), {
    workspaceId,
    title: "Auth rework",
  });

  const renamedList = await ctx.paseo(["workspace", "ls", "--json"]);
  assert.strictEqual(renamedList.exitCode, 0, renamedList.stderr);
  assert.strictEqual(
    JSON.parse(renamedList.stdout).find(
      (workspace: { workspaceId: string }) => workspace.workspaceId === workspaceId,
    )?.name,
    "Auth rework",
  );

  const reset = await ctx.paseo(["workspace", "rename", workspaceId, "--reset", "--json"]);
  assert.strictEqual(reset.exitCode, 0, reset.stderr);
  assert.deepStrictEqual(JSON.parse(reset.stdout), { workspaceId, title: null });

  const resetList = await ctx.paseo(["workspace", "ls", "--json"]);
  assert.strictEqual(resetList.exitCode, 0, resetList.stderr);
  assert.strictEqual(
    JSON.parse(resetList.stdout).find(
      (workspace: { workspaceId: string }) => workspace.workspaceId === workspaceId,
    )?.name,
    basename(ctx.workDir),
  );

  await verifyWorkspaceCallerContext();
} finally {
  await ctx.stop();
}

console.log("=== Workspace Rename Command Tests Passed ===");

async function verifyWorkspaceCallerContext() {
  const sdk = createPaseoClient({ url: `${ctx.wsUrl}/ws`, reconnect: { enabled: false } });
  try {
    await sdk.connect();
    const parentWorkspace = await sdk.workspaces.create({
      source: { kind: "directory", path: ctx.workDir },
      background: true,
    });
    // Creation without a prompt stays idle; this visibility test runs no provider turn.
    const parent = await parentWorkspace.agents.create({ config: { provider: "claude/haiku" } });
    const cases = [
      { caller: parent.id, background: undefined, expected: true },
      { caller: parent.id, background: false, expected: false },
      { caller: parent.id, background: true, expected: true },
      { caller: "foreign-or-missing-agent", background: undefined, expected: false },
      { caller: "foreign-or-missing-agent", background: true, expected: true },
      { caller: "foreign-or-missing-agent", background: false, expected: false },
      { caller: "", background: undefined, expected: false },
      { caller: "", background: true, expected: true },
    ];
    for (const entry of cases) {
      const result = await ctx.paseo(
        [
          "workspace",
          "create",
          "--host",
          `127.0.0.1:${ctx.port}`,
          "--isolation",
          "local",
          "--path",
          ctx.workDir,
          ...(entry.background === undefined
            ? []
            : [entry.background ? "--background" : "--no-background"]),
          "--json",
        ],
        { env: { PASEO_AGENT_ID: entry.caller } },
      );
      assert.strictEqual(result.exitCode, 0, result.stderr);
      assert.strictEqual(
        JSON.parse(result.stdout).background,
        entry.expected,
        JSON.stringify(entry),
      );
    }
    console.log("✓ workspace create caller inheritance, foreign/blank defaults, and overrides");
  } finally {
    await sdk.close();
  }
}
