import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { createFactoryMachineIdentityCommand } from "./machine-identity.js";

const dependencies = vi.hoisted(() => ({
  resolveInstalledFactoryHost: vi.fn(),
  verifyFactoryMachineOverlap: vi.fn(async () => true),
}));
vi.mock("@getpaseo/server", async () => ({
  ...(await import("../../../../server/src/server/factory/lean/machines/machine-identity.js")),
  ...dependencies,
}));
vi.mock("../../utils/daemon-target.js", () => ({ selectDaemonTarget: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("shows public identity and stages and activates the exact key through the local CLI", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "factory-machine-cli-"));
  const home = join(root, "state", "host");
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, "installation.json"),
      JSON.stringify({ version: 1, root, hostHome: home }),
      { mode: 0o600 },
    );
    await writeFile(join(home, "server-id"), "srv_fixture\n", { mode: 0o600 });
    dependencies.resolveInstalledFactoryHost.mockResolvedValue({
      paseoHome: home,
      serverId: "srv_fixture",
    });
    vi.stubEnv("PASEO_HOME", undefined);
    vi.stubEnv("PASEO_HOST", undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    async function run(...args: string[]) {
      stdout.mockClear();
      const cli = new Command()
        .option("--json")
        .addCommand(createFactoryMachineIdentityCommand(async () => "owner/repo"));
      await cli.parseAsync(["--json", "machine", ...args], { from: "user" });
      return JSON.parse(String(stdout.mock.calls[0][0]));
    }

    const initial = await run("show", "project");
    expect(initial).toMatchObject({
      installation: "srv_fixture/project",
      active: null,
      pending: null,
    });
    const generated = await run("generate", "project");
    const staged = await run("rotate", "project");
    const activated = await run("activate", "project", staged.pending.fingerprint);
    expect(staged.active).toEqual(generated.active);
    expect(activated.active).toEqual(staged.pending);
    expect(activated.pending).toBeNull();
    expect(JSON.stringify(activated)).toContain("BEGIN PUBLIC KEY");
    expect(JSON.stringify(activated)).not.toContain("PRIVATE KEY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
