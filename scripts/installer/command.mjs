// The managed `vorteo` command shim in ~/.local/bin. Keep the shim format and the PATH
// advice aligned with install.sh install_command.
//
// This module stays light on imports: scripts/publish-instance-web.mjs loads it from a
// new release while an older coordinator is still running (see installReleaseCommand).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { shellQuote } from "./primitives.mjs";

const MARKER = "# vorteo-command-shim";
const INSTALL_ADDRESS = "https://github.com/terran-labs/vorteo/releases/latest/download/install.sh";
// detect.mjs exports this as JOURNAL; importing it here would load the whole upgrade engine.
const JOURNAL = path.join("state", "install.json");

/**
 * Installs or refreshes the shim and returns one sentence for the owner. It never
 * replaces a `vorteo` it did not write, never edits a shell profile, and never throws: a
 * command that cannot be written must not fail the update that called it.
 */
export function installCommand({ home, root, source, node, env = {}, platform }) {
  const directory = path.join(home, ".local", "bin");
  const target = path.join(directory, "vorteo");
  try {
    if (existsSync(target) && !readFileSync(target, "utf8").includes(MARKER))
      return `Left ${target} alone because something else is installed there.`;
    mkdirSync(directory, { recursive: true });
    const text = [
      "#!/usr/bin/env bash",
      MARKER,
      "# Installed by Vorteo. Forwards to the command in the installed release.",
      `VORTEO_ROOT=\${VORTEO_ROOT:-${shellQuote(root)}}`,
      `VORTEO_NODE=\${VORTEO_NODE:-${shellQuote(node)}}`,
      `VORTEO_SOURCE=\${VORTEO_SOURCE:-${shellQuote(source)}}`,
      "export VORTEO_ROOT VORTEO_NODE VORTEO_SOURCE",
      'script="$VORTEO_SOURCE/scripts/installer/vorteo.sh"',
      'if [ ! -f "$script" ]; then',
      `  echo "Vorteo is not installed in $VORTEO_ROOT. Install it with: curl -fsSL ${INSTALL_ADDRESS} | bash" >&2`,
      "  exit 1",
      "fi",
      'exec bash "$script" "$@"',
      "",
    ].join("\n");
    // Write beside the target and rename, so a reader never sees a partial shim.
    writeFileSync(`${target}.tmp`, text);
    chmodSync(`${target}.tmp`, 0o755);
    renameSync(`${target}.tmp`, target);
  } catch (error) {
    return `The vorteo command could not be installed in ${target}: ${error.message}`;
  }
  const message = `Installed the vorteo command in ${target}.`;
  if ((env.PATH ?? "").split(path.delimiter).includes(directory)) return message;
  const shell = path.basename(env.SHELL ?? "");
  if (shell === "fish")
    return `${message} ${directory} is not on your PATH. Run: fish_add_path ${directory}`;
  let profile = "your shell profile";
  if (shell === "zsh") profile = "~/.zshrc";
  if (shell === "bash") profile = platform === "darwin" ? "~/.bash_profile" : "~/.bashrc";
  return `${message} ${directory} is not on your PATH. Add this line to ${profile}: export PATH="$HOME/.local/bin:$PATH"`;
}

/**
 * Installs the command for the installation that runs `release` as its Host, and returns
 * the sentence for the owner, or "" when `release` is not an installation's selected Host
 * release (a task checkout, a build folder, a release not yet selected).
 *
 * The installation is the nearest folder above `release` whose install journal names a
 * Host release link that resolves to `release`. Releases live under the installation
 * root, so this needs no argument from the caller. That matters: the caller is the
 * publisher, run from the new release by whichever coordinator performs the update, and a
 * coordinator from before this command existed passes nothing about the installation.
 */
export function installReleaseCommand({ release, home, env = {}, platform }) {
  const selected = realpathSync(release);
  for (let folder = path.dirname(selected); ; folder = path.dirname(folder)) {
    const plan = readPlan(path.join(folder, JOURNAL));
    const link = plan?.paths?.hostReleaseLink;
    if (typeof link === "string" && resolves(link) === selected)
      return installCommand({
        home,
        root: folder,
        source: link,
        node: plan.executables?.node ?? process.execPath,
        env,
        platform,
      });
    if (folder === path.dirname(folder)) return "";
  }
}

function readPlan(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).plan;
  } catch {
    return undefined;
  }
}

function resolves(link) {
  try {
    return realpathSync(link);
  } catch {
    return undefined;
  }
}
