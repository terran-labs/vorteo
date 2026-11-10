import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { compilePlugin } from "../compiler.js";
import { readPluginManifest } from "../manifest.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader, builtinPlugins, resolveBuiltinPluginsRoot } from "./index.js";
import { ProjectFactoryStateSchema } from "../../../../../../plugins/factory/shared/project.js";
const TMP_ROOT = realpathSync(os.tmpdir());
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(root: string, id: string, client = false): Promise<string> {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: { paseo: ">=0.9.2" } }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    "export default function contribute() { return () => {}; }",
  );
  if (client) {
    await writeFile(
      path.join(directory, "index.client.tsx"),
      "export default function contribute() { const marker = 'builtin-client-marker'; void marker; return () => {}; }",
    );
  }
  return directory;
}

test("listed built-ins resolve to matching manifests and compile", async () => {
  const root = resolveBuiltinPluginsRoot();
  for (const id of builtinPlugins) {
    const directory = path.join(root, id);
    expect((await readPluginManifest(directory)).id).toBe(id);
    const findEntry = async (names: string[]) => {
      for (const name of names) {
        const entry = path.join(directory, name);
        if ((await stat(entry).catch(() => null))?.isFile()) return entry;
      }
      return null;
    };
    const bundles = await compilePlugin({
      server: await findEntry(["index.server.ts", "index.server.tsx"]),
      client: await findEntry(["index.client.ts", "index.client.tsx"]),
    });
    expect(bundles.serverBundle).toBeTruthy();
  }
});

test("listed client bundle is published while plugins are disabled; unlisted directory is inert", async () => {
  const root = await mkdtemp(path.join(TMP_ROOT, "paseo-builtin-fixture-"));
  roots.push(root);
  await fixture(root, "listed", true);
  await fixture(root, "unlisted", true);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["listed"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    expect(await client.listPlugins()).toEqual([]);
    const catalog = await client.getPluginCatalog();
    expect(catalog.map(({ id }) => id)).toEqual(["listed"]);
    expect(catalog[0]?.clientBundle).toContain("builtin-client-marker");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("a repeated catalog fetch leaves out the client bundle the client already holds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-builtin-catalog-cache-"));
  roots.push(root);
  const directory = await fixture(root, "large", true);
  // About the size of a real plugin client bundle.
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `const payload = ${JSON.stringify("x".repeat(1_000_000))};
export default function contribute() { void payload; return () => {}; }`,
  );
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["large"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  const responseBytes: number[] = [];
  const unsubscribe = client.subscribeRawMessages((message) => {
    if (message.type === "plugin.catalog.get.response") {
      responseBytes.push(JSON.stringify(message).length);
    }
  });
  try {
    await client.connect();
    const first = await client.getPluginCatalog();
    const second = await client.getPluginCatalog();

    expect(second).toEqual(first);
    expect(second[0]?.clientBundle).toContain("x".repeat(1_000_000));
    expect(responseBytes).toHaveLength(2);
    expect(responseBytes[0]).toBeGreaterThan(1_000_000);
    expect(responseBytes[1]).toBeLessThan(500);
  } finally {
    unsubscribe();
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("directory, Git, and npm installs reject a built-in ID", async () => {
  const root = await mkdtemp(path.join(TMP_ROOT, "paseo-builtin-install-"));
  roots.push(root);
  const directory = await fixture(root, "reserved");
  const gitDirectory = await fixture(root, "git-source");
  await writeFile(
    path.join(gitDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "reserved", requirements: { paseo: ">=0.9.2" } }),
  );
  execFileSync("git", ["init", "-q", gitDirectory]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Paseo Tests",
    "-c",
    "user.email=paseo@example.test",
    "add",
    ".",
  ]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Paseo Tests",
    "-c",
    "user.email=paseo@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["reserved"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    await expect(client.installDirectoryPlugin(directory)).rejects.toThrow(
      /reserved for a built-in/,
    );
    await expect(
      client.installPluginSource({ source: pathToFileURL(gitDirectory).href }),
    ).rejects.toThrow(/reserved for a built-in/);
    await expect(
      client.installPluginSource({ source: "npm:unused-fixture", id: "reserved" }),
    ).rejects.toThrow(/reserved for a built-in/);
    expect(await client.listPlugins()).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("bundled Factory serves per-project state without the retired controller RPCs", async () => {
  const root = await mkdtemp(path.join(TMP_ROOT, "factory-project-rpc-"));
  roots.push(root);
  const version = "0.11.0-beta.3.vorteo.254";
  const daemon = await createTestPaseoDaemon({
    daemonVersion: version,
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["factory"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: version });
  try {
    await client.connect();
    const opened = await client.openProject(root);
    if (!opened.workspace) throw new Error(opened.error ?? "Test workspace did not open");
    const projectId = opened.workspace.projectId;
    const beforeWorkspaces = await client.fetchWorkspaces();
    const beforeAgents = await client.fetchAgents();
    const state = ProjectFactoryStateSchema.parse(
      await client.invokePluginRpc("factory", "factory.project.get", { projectId }),
    );
    expect(state).toMatchObject({ projectId, state: "off", repository: null });
    expect(state.serverId).toBeTruthy();
    await expect(
      client.invokePluginRpc("factory", "factory.project.enable", { projectId, repository: "x" }),
    ).rejects.toThrow();
    for (const method of [
      "factory.setup",
      "factory.install",
      "factory.controls",
      "factory.control",
      "factory.snapshot",
      "activity.receipts",
    ]) {
      await expect(client.invokePluginRpc("factory", method, { projectId })).rejects.toThrow();
    }
    expect((await client.fetchWorkspaces()).entries).toEqual(beforeWorkspaces.entries);
    expect((await client.fetchAgents()).entries).toEqual(beforeAgents.entries);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
