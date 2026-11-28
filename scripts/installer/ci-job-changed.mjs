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
  let changed = true;
  const baseSha = process.argv[2] ?? "";
  if (/^[a-f0-9]{40}$/i.test(baseSha)) {
    try {
      const base = execFileSync("git", ["show", `${baseSha}:${workflow}`], {
        encoding: "utf8",
      });
      const before = installerJob(base);
      const after = installerJob(readFileSync(workflow, "utf8"));
      if (before && after) changed = before !== after;
    } catch {
      // An incomplete comparison should run the installer suite.
    }
  }
  console.log(`changed=${changed}`);
}
