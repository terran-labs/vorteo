import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readHostGateExecutorConfig } from "./gate-executor-config.js";

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "fg-"));
  const paseoHome = join(root, "host");
  const runtime = join(root, "engine");
  await Promise.all([mkdir(paseoHome, { mode: 0o700 }), mkdir(runtime, { mode: 0o700 })]);
  const filename = join(paseoHome, "factory-gate-executor.json");
  const socket = join(runtime, "gate.sock");
  const dockerBinary = join(runtime, "docker");
  const config = { dockerBinary, socket, image: `sha256:${"a".repeat(64)}`, uid: 1000, gid: 1000 };
  await writeFile(dockerBinary, "inert executable fixture", { mode: 0o700 });
  const server = createServer();
  server.listen(socket);
  await once(server, "listening");
  await chmod(socket, 0o600);
  return {
    config,
    filename,
    runtime,
    input: { paseoHome, guestRoots: [] },
    async dispose() {
      const closed = once(server, "close");
      server.close();
      await closed;
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("reads an optional private native configuration without running the executable", async () => {
  const f = await fixture();
  try {
    expect(await readHostGateExecutorConfig(f.input)).toBeUndefined();
    await writeFile(f.filename, JSON.stringify(f.config), { mode: 0o600 });
    expect(await readHostGateExecutorConfig(f.input)).toEqual(f.config);
    await chmod(f.filename, 0o644);
    await expect(readHostGateExecutorConfig(f.input)).rejects.toThrow("private regular Host file");
  } finally {
    await f.dispose();
  }
});

it("refuses mutable images, root IDs, symlinks, guest paths, and repository assets", async () => {
  const f = await fixture();
  try {
    for (const invalid of [{ image: "node:latest" }, { uid: 0 }, { gid: 0 }, { extra: true }]) {
      await writeFile(f.filename, JSON.stringify({ ...f.config, ...invalid }), { mode: 0o600 });
      await expect(readHostGateExecutorConfig(f.input)).rejects.toThrow("image SHA");
    }
    const alias = join(f.runtime, "alias");
    await symlink(f.config.dockerBinary, alias);
    await writeFile(f.filename, JSON.stringify({ ...f.config, dockerBinary: alias }));
    await expect(readHostGateExecutorConfig(f.input)).rejects.toThrow("symbolic links");
    await writeFile(f.filename, JSON.stringify({ ...f.config, socket: f.config.dockerBinary }));
    await expect(readHostGateExecutorConfig(f.input)).rejects.toThrow("local Unix Docker socket");
    await writeFile(f.filename, JSON.stringify(f.config));
    await expect(
      readHostGateExecutorConfig({ ...f.input, guestRoots: [f.runtime] }),
    ).rejects.toThrow("protected native Host paths");
    await mkdir(join(f.runtime, ".git"));
    await expect(readHostGateExecutorConfig(f.input)).rejects.toThrow("outside Git checkouts");
  } finally {
    await f.dispose();
  }
});
