import { expect, test } from "vitest";
import * as installationProtocol from "./execution-installation.js";
import { MaintenanceServiceViewSchema } from "./maintenance-service-status.js";
import {
  installationHasContainer,
  InstallationUnlockSchema,
  RestartRequestSchema,
  SourceContributionSchema,
  validateExecutionInstallation,
} from "./execution-installation.js";

const installation = {
  version: 1,
  installationId: "3386c661-7e90-4e01-abf7-e7ca3b9fca00",
  origin: "https://installation.example.test",
  environments: [
    {
      kind: "container",
      serverId: "container-id",
      endpoint: "container.example.test",
      useTls: true,
    },
    { kind: "host", serverId: "host-id", endpoint: "host.example.test", useTls: true },
  ],
};

test("installation descriptors require distinct encrypted destinations and never contain passwords", () => {
  expect(validateExecutionInstallation(installation).environments).toHaveLength(2);
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [installation.environments[0], installation.environments[0]],
    }),
  ).toThrow("distinct");
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], password: "secret" },
        installation.environments[1],
      ],
    }),
  ).toThrow();
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], endpoint: "container.example.test/path" },
        installation.environments[1],
      ],
    }),
  ).toThrow("endpoint");
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], useTls: false },
        installation.environments[1],
      ],
    }),
  ).toThrow("TLS");
});

test("a Host-only installation lists exactly the Host", () => {
  const host = installation.environments[1];
  const hostOnly = validateExecutionInstallation({ ...installation, environments: [host] });
  expect(hostOnly.environments).toEqual([host]);
  expect(installationHasContainer(hostOnly)).toBe(false);
  expect(installationHasContainer(validateExecutionInstallation(installation))).toBe(true);
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [installation.environments[0]],
    }),
  ).toThrow("Host environment");
  expect(() => validateExecutionInstallation({ ...installation, environments: [] })).toThrow();
  expect(() =>
    validateExecutionInstallation({ ...installation, environments: [host, host, host] }),
  ).toThrow();
  expect(
    InstallationUnlockSchema.parse({
      installationId: installation.installationId,
      connections: [{ ...host, password: "secret" }],
    }).connections,
  ).toHaveLength(1);
});

test("a local-only installation serves plain HTTP on localhost with a loopback Host", () => {
  const local = validateExecutionInstallation({
    ...installation,
    origin: "http://localhost:6770",
    environments: [
      { kind: "host", serverId: "host-id", endpoint: "127.0.0.1:6767", useTls: false },
    ],
  });
  expect(local.origin).toBe("http://localhost:6770");
  expect(() =>
    validateExecutionInstallation({ ...installation, origin: "http://installation.example.test" }),
  ).toThrow("HTTPS");
});

test("owner approval requirements are optional durable request and contribution metadata", () => {
  const request = { target: "host", reason: "Review explicitly" };
  expect(RestartRequestSchema.parse(request)).not.toHaveProperty("requireOwnerApproval");
  expect(RestartRequestSchema.parse({ ...request, requireOwnerApproval: true })).toMatchObject({
    requireOwnerApproval: true,
  });
  expect(() => RestartRequestSchema.parse({ ...request, requireOwnerApproval: "true" })).toThrow();
  const contribution = {
    id: "3386c661-7e90-4e01-abf7-e7ca3b9fca00",
    update: {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "c".repeat(64),
      bytes: 1,
    },
    reason: "Review source",
    requestedBy: "host-agent",
    createdAt: new Date(0).toISOString(),
    status: "queued",
    detail: "Awaiting integration",
    requireOwnerApproval: true,
  };
  expect(SourceContributionSchema.parse(contribution)).toMatchObject({
    requestedBy: "host-agent",
    requireOwnerApproval: true,
  });
});

test("the operation progress marker is exported only with the reply fields it promises", () => {
  // Clients send operationProgress=1 only when this marker exists. A partial revert that kept it
  // without the fields would make strict client schemas reject every progress reply.
  if (!("OPERATION_PROGRESS_REPLY" in installationProtocol)) return;
  const restart = installationProtocol.RestartJobSchema.shape;
  for (const field of ["progressReconstructed", "startedAt", "step", "steps", "requesterNotice"]) {
    expect(restart).toHaveProperty(field);
  }
  for (const field of ["startedAt", "step", "stepStartedAt", "finishedAt"]) {
    expect(MaintenanceServiceViewSchema.shape).toHaveProperty(field);
  }
});
