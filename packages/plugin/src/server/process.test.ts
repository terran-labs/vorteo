import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { execCommand, spawnProcess } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeArgumentReader(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin process arguments "));
  roots.push(root);
  const script = path.join(root, "read arguments.mjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  return script;
}

const argumentsToPreserve = [
  "argument with spaces",
  "--format=%(refname)%09%(committerdate:unix)",
  "100%",
  "feature&bugfix",
  "feature|bugfix",
  "feature^bugfix",
];

// A bare extensionless command selects the Windows shell; an absolute node.exe path would
// skip that path. The real child checks quoting through the public process capabilities.
test("execCommand delivers shell arguments to the real child unchanged", async () => {
  const script = await writeArgumentReader();
  const { stdout } = await execCommand("node", [script, ...argumentsToPreserve]);
  expect(JSON.parse(stdout)).toEqual(argumentsToPreserve);
});

test("spawnProcess delivers shell arguments to the real child unchanged", async () => {
  const script = await writeArgumentReader();
  const child = spawnProcess("node", [script, ...argumentsToPreserve], { stdio: "pipe" });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Argument reader exited with ${code}`));
    });
  });
  expect(JSON.parse(stdout)).toEqual(argumentsToPreserve);
});

// Windows terminates immediately on SIGTERM, so only POSIX can hold this boundary open.
test.skipIf(process.platform === "win32").each([
  { killSignal: undefined, cooperative: true },
  { killSignal: undefined, cooperative: false },
  { killSignal: "SIGKILL", cooperative: false },
] as const)(
  "aborted commands wait for child closure with kill signal %s",
  async ({ killSignal, cooperative }) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const connected = once(server, "connection");
    const controller = new AbortController();
    let settled = false;
    const pending = execCommand(
      process.execPath,
      [
        "-e",
        `
    const socket = require('node:net').connect(${address.port}, '127.0.0.1');
    process.on('SIGTERM', () => socket.write('stopping'));
    socket.on('connect', () => socket.write(String(process.pid)));
    socket.on('data', () => process.exit(0));
  `,
      ],
      { signal: controller.signal, killSignal },
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    const [socket] = await connected;
    const pid = Number(String((await once(socket, "data"))[0]));
    try {
      if (killSignal) {
        controller.abort();
        // The child ignores SIGTERM until told to exit. An explicit SIGKILL must end it.
        await expect.poll(() => settled).toBe(true);
      } else {
        const stopping = once(socket, "data");
        controller.abort();
        await stopping;
        expect(settled).toBe(false);
        if (cooperative) socket.write("exit");
        else await expect.poll(() => settled, { timeout: 4000 }).toBe(true);
      }
      expect(await pending).toMatchObject({ code: "ABORT_ERR" });
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(
        execCommand(process.execPath, ["-e", ""], { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "ABORT_ERR" });
    } finally {
      if (!socket.destroyed) socket.write("exit");
      await pending;
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
