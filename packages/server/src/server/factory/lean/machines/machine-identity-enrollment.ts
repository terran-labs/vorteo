import { z } from "zod";
import { createLeanGitHubClient } from "../github-client.js";
import { readMachinePublicKey } from "./host-key.js";
import { resolveMachineRoles } from "./roles.js";

const repositorySchema = z.object({
  full_name: z.string(),
  default_branch: z.string().min(1),
});
const refSchema = z.object({
  ref: z.string(),
  object: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) }),
});

async function currentDevConfig(repository: string) {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/iu.test(repository) || /\/\.{1,2}$/u.test(repository)) {
    return false;
  }
  const github = createLeanGitHubClient();
  async function defaultHead(): Promise<string | null> {
    const repo = await github.rest("GET", `repos/${repository}`);
    const result = repositorySchema.safeParse(repo.body);
    if (
      repo.status !== 200 ||
      !result.success ||
      result.data.full_name.toLowerCase() !== repository.toLowerCase()
    )
      return null;
    const branch = result.data.default_branch;
    if (branch.split("/").some((part) => part === "." || part === ".." || !part)) return null;
    const route = branch
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const ref = await github.rest("GET", `repos/${repository}/git/ref/heads/${route}`);
    const parsed = refSchema.safeParse(ref.body);
    return ref.status === 200 && parsed.success && parsed.data.ref === `refs/heads/${branch}`
      ? parsed.data.object.sha
      : null;
  }

  const head = await defaultHead();
  if (!head) return false;
  const { readPinnedFactoryConfig } = await import("./pinned-factory-config.js");
  const config = await readPinnedFactoryConfig(github, repository, head);
  if (
    !z.object({ runners: z.object({ placement: z.literal("dev") }) }).safeParse(config).success ||
    (await defaultHead()) !== head
  )
    return null;
  return config;
}

export async function factoryProjectAllowsMachineKeys(repository: string): Promise<boolean> {
  return Boolean(await currentDevConfig(repository));
}

/** Retire the old public key only after evidence signed with it has drained. */
export async function verifyFactoryMachineOverlap(input: {
  repository: string;
  installation: string;
  active: string;
  pending: string;
}): Promise<boolean> {
  const { repository, installation } = input;
  const config = await currentDevConfig(repository);
  if (!config) return false;
  const { roles } = resolveMachineRoles(config, installation);
  const enrolled = roles?.publicKeysFor(installation).map(readMachinePublicKey) ?? [];
  const active = readMachinePublicKey(input.active);
  const pending = readMachinePublicKey(input.pending);
  return (
    active !== null &&
    pending !== null &&
    !active.equals(pending) &&
    enrolled.some((key) => key?.equals(active)) &&
    enrolled.some((key) => key?.equals(pending))
  );
}
