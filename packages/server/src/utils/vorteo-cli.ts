/** The Host dispatcher opts into branded hints; standalone and Dev callers keep paseo. */
export function cliCommand(command = ""): string {
  const name = process.env.VORTEO_CLI_NAME === "vorteo" ? "vorteo" : "paseo";
  if (name === "vorteo") {
    if (command === "status") return "vorteo daemon status";
    if (command === "--help") return "vorteo --json --help";
  }
  return command ? `${name} ${command}` : name;
}
