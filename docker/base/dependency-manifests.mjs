// Writes the files `npm ci` needs into <out>, with this repository's own version replaced by
// 0.0.0. Every commit bumps that version in each workspace manifest, in the workspaces' exact
// cross-references and in the lockfile. Normalizing it lets Docker reuse the dependency install
// layer until a real dependency changes. Usage: node dependency-manifests.mjs <source> <out>
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [source, out] = process.argv.slice(2);
if (!source || !out) throw new Error("Usage: dependency-manifests.mjs <source> <out>");
const NORMAL = "0.0.0";
const read = (file) => JSON.parse(readFileSync(path.join(source, file), "utf8"));
const write = (file, value) => {
  mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
  writeFileSync(path.join(out, file), `${JSON.stringify(value, null, 2)}\n`);
};

const root = read("package.json");
const version = root.version;
const workspaceDirs = root.workspaces.filter((dir) =>
  existsSync(path.join(source, dir, "package.json")),
);
const workspaceNames = new Set(workspaceDirs.map((dir) => read(`${dir}/package.json`).name));
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** Replaces this repository's version on the package and on its references to sibling workspaces. */
function normalize(manifest) {
  if (manifest.version === version) manifest.version = NORMAL;
  for (const field of DEPENDENCY_FIELDS)
    for (const name of Object.keys(manifest[field] ?? {}))
      if (workspaceNames.has(name) && manifest[field][name] === version)
        manifest[field][name] = NORMAL;
  return manifest;
}

// The root lifecycle `prepare` installs Git hooks, which an image build has no use for.
delete root.scripts?.prepare;
write("package.json", normalize(root));
for (const dir of workspaceDirs)
  write(`${dir}/package.json`, normalize(read(`${dir}/package.json`)));

const lock = read("package-lock.json");
if (lock.version === version) lock.version = NORMAL;
for (const key of ["", ...workspaceDirs]) if (lock.packages?.[key]) normalize(lock.packages[key]);
write("package-lock.json", lock);

// The root postinstall applies these patches.
for (const file of [".npmrc", "scripts/postinstall-patches.mjs", "patches"])
  if (existsSync(path.join(source, file)))
    cpSync(path.join(source, file), path.join(out, file), { recursive: true });
