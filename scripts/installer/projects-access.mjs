// Linux bind mounts retain numeric owners. Grant the two accounts explicit ACL
// entries instead of changing owners or opening projects to every local account.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { InstallerError } from "./primitives.mjs";

export async function verifyProjectsAccess({ plan, context, outputs }) {
  const directory = path.join(
    realpathSync(plan.paths.projectsFolder),
    `.vorteo-sharing-${randomUUID()}`,
  );
  mkdirSync(directory);
  const hostFile = path.join(directory, "host.txt");
  const devFolder = path.join(directory, "dev");
  const devFile = path.join(devFolder, "dev.txt");
  const exec = (script, ...args) =>
    context.run(plan.executables.docker, [
      "exec",
      "--user",
      plan.dev.user,
      `${outputs.instance}-paseo-1`,
      "node",
      "-e",
      script,
      ...args,
    ]);
  try {
    writeFileSync(hostFile, "host");
    await exec(
      "const fs=require('fs'); process.umask(0o077); fs.appendFileSync(process.argv[1],'+dev'); fs.mkdirSync(process.argv[2]); fs.writeFileSync(process.argv[3],'dev');",
      hostFile,
      devFolder,
      devFile,
    );
    if (readFileSync(hostFile, "utf8") !== "host+dev" || readFileSync(devFile, "utf8") !== "dev")
      throw new Error("Host and Dev could not read each other's project files.");
    writeFileSync(devFile, "dev+host");
    await exec(
      "if(require('fs').readFileSync(process.argv[1],'utf8')!=='dev+host')process.exit(1)",
      devFile,
    );
  } finally {
    // This tree contains only our probe. Preserve the original failure if a broken
    // filesystem also prevents cleanup; the unique path identifies leftover data.
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* reported by the access probe */
    }
  }
}

function readReceipt(receipt) {
  const lines = readFileSync(receipt, "utf8").split("\n");
  // Without a complete initial snapshot, the helper cannot have begun mutations.
  if (lines.length < 2 || !lines[0]) return null;
  const data = JSON.parse(lines[0]);
  for (const line of lines.slice(1, -1)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    Object.assign(data, event);
  }
  return data;
}

export async function projectsAccess(s) {
  const { plan, context, outputs, journal } = s;
  if (plan.platform !== "linux")
    return { skip: "Linux folder permissions are not needed on this platform." };
  const devUid = Number(
    (
      await context.run(plan.executables.docker, [
        "exec",
        "--user",
        plan.dev.user,
        `${outputs.instance}-paseo-1`,
        "id",
        "-u",
      ])
    ).trim(),
  );
  if (!Number.isInteger(devUid) || devUid <= 0 || context.uid <= 0)
    throw new InstallerError(
      "Cannot identify the Host and Dev accounts for project sharing.",
      "Run the installer as your ordinary Host account and check the Dev user.",
    );
  const backups = path.join(plan.paths.root, "permissions-backups");
  try {
    if (devUid !== context.uid) {
      mkdirSync(backups, { recursive: true, mode: 0o700 });
      const helper = async (action, receipt) =>
        context.run(plan.executables.docker, [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "DAC_OVERRIDE",
          "--cap-add",
          "FOWNER",
          "--cap-add",
          "FSETID",
          "--user",
          "0:0",
          "--mount",
          `type=bind,src=${realpathSync(plan.paths.projectsFolder)},dst=/share`,
          "--mount",
          `type=bind,src=${receipt},dst=/receipt`,
          "--mount",
          `type=bind,src=${path.join(plan.paths.source, "scripts/installer/projects-permissions.py")},dst=/helper.py,readonly`,
          "--entrypoint",
          "python3",
          outputs.devImage,
          "-I",
          "/helper.py",
          action,
          "/receipt",
          String(context.uid),
          String(devUid),
        ]);
      for (const name of readdirSync(backups).filter((entry) =>
        /^projects-[a-f0-9-]+\.jsonl$/.test(entry),
      )) {
        const receipt = path.join(backups, name);
        const data = readReceipt(receipt);
        if (!data) continue;
        if (data.retainedChanges?.length)
          throw new Error(`Resolve changed objects listed in ${receipt} before retrying.`);
        if (data.state === "prepared") await helper("recover", receipt);
      }
      const receipt = path.join(backups, `projects-${randomUUID()}.jsonl`);
      writeFileSync(receipt, "", { mode: 0o600, flag: "wx" });
      journal.output({ projectsPermissionsReceipt: receipt });
      await helper("prepare", receipt);
    }
    await verifyProjectsAccess(s);
  } catch (error) {
    throw new InstallerError(
      `Shared Projects access failed: ${error.message}`,
      `Stop programs changing ${plan.paths.projectsFolder}, then rerun the installer or repair. The filesystem must support POSIX ACLs. Files owned by other accounts, special files, and hard links outside Projects must be moved outside the selected folder by their owner. Permission backups remain in ${backups}; file ownership is never changed.`,
    );
  }
  return {
    message:
      "Host and Dev can create and edit shared project files; existing file ownership is preserved.",
  };
}
