import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Compare the installer job only. Other jobs in this shared workflow have their own routing.
export function installerJob(source) {
  const block = /^  installer-tests:[^\n]*\n([\s\S]*?)(?=^  [\w-]+:|(?![\s\S]))/m.exec(source);
  return block?.[0].replace(/^  #.*\n?/gm, "").trimEnd();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workflow = ".github/workflows/ci.yml";
  const base = execFileSync("git", ["show", `${process.argv[2]}:${workflow}`], {
    encoding: "utf8",
  });
  const current = readFileSync(workflow, "utf8");
  console.log(`changed=${installerJob(base) !== installerJob(current)}`);
}
