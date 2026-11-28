import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { expect, it } from "vitest";
import { readBoundDevInstallation } from "./installation.js";

it("selects Dev only from the private paired installation record matching the running Host", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dev-installation-")));
  try {
    const home = join(root, "state", "host");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const write = (file: string, value: unknown) =>
      writeFile(join(root, file), JSON.stringify(value), { mode: 0o600 });
    await write("installation.json", { version: 1, root, hostHome: home });
    await writeFile(join(home, "server-id"), "host", { mode: 0o600 });
    const expected = {
      installationId: "1ea1422d-c7ee-41dd-864f-d1588059a9fb",
      hostServerId: "host",
      devServerId: "dev",
    };
    const descriptor = {
      version: 1,
      installationId: expected.installationId,
      origin: "https://example.test",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.invalid", useTls: true },
        { kind: "container", serverId: "dev", endpoint: "dev.invalid", useTls: true },
      ],
    };
    await write("coordinator.json", { public: descriptor, container: {} });
    const args = {
      environment: "host" as const,
      serverId: "host",
      paseoHome: home,
      clientConfigFile: join(root, "host-agent.json"),
    };
    expect(await readBoundDevInstallation(args)).toEqual(expected);
    expect(await readBoundDevInstallation({ ...args, environment: "container" })).toBeNull();
    expect(await readBoundDevInstallation({ ...args, serverId: "wrong" })).toBeNull();
    await write("coordinator.json", { public: descriptor });
    expect(await readBoundDevInstallation(args)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
