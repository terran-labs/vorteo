import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createLeanGitHubClient } from "../github-client.js";
import { verifyFactoryMachineOverlap } from "./machine-identity-enrollment.js";
import { readPinnedFactoryConfig } from "./pinned-factory-config.js";
import type { FactoryGitHub } from "../../project/claims.js";

vi.mock("../github-client.js", () => ({ createLeanGitHubClient: vi.fn() }));
vi.mock("./pinned-factory-config.js", () => ({ readPinnedFactoryConfig: vi.fn() }));

it("requires both project keys on the same current owner default-branch commit", async () => {
  const makeKey = () =>
    generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const active = makeKey();
  const pending = makeKey();
  const installation = "host/project";
  const first = "a".repeat(40);
  let current = first;
  const rest: FactoryGitHub["rest"] = async (_method, route) => ({
    status: 200,
    body: route.endsWith("/owner/repo")
      ? { full_name: "owner/repo", default_branch: "main" }
      : { ref: "refs/heads/main", object: { sha: current } },
  });
  vi.mocked(createLeanGitHubClient).mockReturnValue({ rest });
  const config = {
    version: 1,
    mode: "lean",
    order: [installation],
    machines: { [installation]: { publicKey: active, overlapPublicKey: pending } },
  };
  const input = { repository: "owner/repo", installation, active, pending };
  vi.mocked(readPinnedFactoryConfig).mockResolvedValueOnce({
    ...config,
    machines: { [installation]: { publicKey: active } },
  });
  expect(await verifyFactoryMachineOverlap(input)).toBe(false);

  vi.mocked(readPinnedFactoryConfig).mockResolvedValueOnce(config);
  expect(await verifyFactoryMachineOverlap(input)).toBe(true);
  expect(readPinnedFactoryConfig).toHaveBeenLastCalledWith({ rest }, "owner/repo", first);

  vi.mocked(readPinnedFactoryConfig).mockImplementationOnce(async () => {
    current = "b".repeat(40);
    return config;
  });
  expect(await verifyFactoryMachineOverlap(input)).toBe(false);
});
