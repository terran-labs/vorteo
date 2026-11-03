// Bundle at development time so `curl | bash --demo` needs no downloads or temporary files.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
const result = await build({
  stdin: {
    contents:
      'import { demoMain } from "./demo.mjs"; try { await demoMain(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }',
    resolveDir: new URL(".", import.meta.url).pathname,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  write: false,
});
const file = new URL("../../install.sh", import.meta.url);
const source = readFileSync(file, "utf8");
const block = `# BEGIN demo bundle
vorteo_demo() {
  local runtime="$1"
  shift
  "$runtime" --input-type=module - "$@" <<'VORTEO_DEMO_JS'
${result.outputFiles[0].text}VORTEO_DEMO_JS
}
# END demo bundle`;
const updated = source.replace(/# BEGIN demo bundle[\s\S]*?# END demo bundle/, block);
if (process.argv.includes("--check")) {
  if (source !== updated)
    throw new Error("Run node scripts/installer/embed-demo.mjs to refresh the embedded demo.");
} else writeFileSync(file, updated);
