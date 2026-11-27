import { createHash } from "node:crypto";
import { z } from "zod";
import type { FactoryGitHub } from "../../project/claims.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const treeSchema = z.object({
  sha,
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha })),
});

function treeEntry(tree: z.infer<typeof treeSchema>, name: string, mode: string, type: string) {
  const entries = tree.tree.filter((entry) => entry.path === name);
  if (entries.length > 1) throw new Error("Factory configuration path is ambiguous.");
  const entry = entries[0];
  if (entry && (entry.mode !== mode || entry.type !== type)) {
    throw new Error("Factory configuration must be a regular file.");
  }
  return entry;
}

/** Read only the regular owner configuration at a caller-verified default branch commit. */
export async function readPinnedFactoryConfig(
  github: FactoryGitHub,
  repository: string,
  configCommit: string,
): Promise<unknown> {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("Invalid Factory repository.");
  sha.parse(configCommit);
  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const result = await github.rest("GET", `repos/${repository}/git/${path}`);
    if (result.status !== 200) throw new Error("GitHub could not read the pinned Factory config.");
    return schema.parse(result.body);
  }

  async function readTree(expected: string) {
    const tree = await get(`trees/${expected}`, treeSchema);
    if (tree.sha !== expected) throw new Error("GitHub returned the wrong Factory config tree.");
    return tree;
  }

  const commit = await get(
    `commits/${configCommit}`,
    z.object({ sha: z.literal(configCommit), tree: z.object({ sha }) }),
  );
  const directory = treeEntry(await readTree(commit.tree.sha), ".github", "040000", "tree");
  if (!directory) return null;
  const entry = treeEntry(await readTree(directory.sha), "vorteo-factory.json", "100644", "blob");
  if (!entry) return null;
  const blob = await get(
    `blobs/${entry.sha}`,
    z.object({
      sha: z.literal(entry.sha),
      encoding: z.literal("base64"),
      content: z.string().max(256 * 1024),
    }),
  );
  const bytes = Buffer.from(blob.content, "base64");
  const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (actual !== entry.sha) throw new Error("GitHub returned the wrong Factory config bytes.");
  return JSON.parse(bytes.toString("utf8"));
}
