import { PreviewBrokerDeploymentJobSchema } from "@getpaseo/protocol/preview-broker-deployment";
import { PreviewBrokerJobSchema } from "@getpaseo/protocol/preview-broker-maintenance";
const id = "cdd5f891-57a9-4871-ad8f-df7d0509c15c";
const directory = { inode: 123, uid: 501, gid: 20, mode: 0o700 };
function broker(name: string) {
  return {
    configPath: `/protected/${name}/host-config.json`,
    fencePath: `/protected/${name}/https-broker-rebind.pending.json`,
    expectedSha256: "a".repeat(64),
    candidateSha256: "b".repeat(64),
    anchor: {
      version: 1,
      filesystem: "apfs",
      volumeUUID: "7785796d-d4b1-445a-a2ad-b673a4dd6683",
      mountPoint: "/System/Volumes/Data",
      ancestors: { "/": directory },
      directories: { "": directory, inbox: directory, receipts: directory, origins: directory },
    },
  };
}
export const brokerReviewFixture = PreviewBrokerJobSchema.parse({
  id,
  revision: "e821c845-f88d-4668-81a3-a78aa665e587",
  target: "preview-broker",
  operation: "preview-broker-channel-rebind",
  requestedBy: "host-agent",
  createdAt: "2026-01-01T00:00:00.000Z",
  reason: "Reviewed APFS trust migration",
  detail: "Exact channel identity change",
  status: "pending",
  stage: "prepared",
  planSha256: "e".repeat(64),
  plan: {
    id,
    version: 1,
    operation: "preview-broker-channel-rebind",
    installationId: "74233052-15e9-48cf-b214-df175c2d7955",
    sourceCommit: "c".repeat(40),
    evidenceDirectory: `/protected/evidence/${id}`,
    continuityEvidence: [{ path: "/protected/continuity.json", sha256: "d".repeat(64) }],
    brokers: [broker("native"), broker("dev")],
  },
});

const consumer = {
  expected: { kind: "present", sha256: "a".repeat(64), identity: Array(9).fill("1") },
  candidate: { path: "/protected/candidate", sha256: "b".repeat(64) },
  mode: 0o700,
};
const target = (root: string) => ({
  root,
  directory: [1, 2, 501, 20, 0o700],
  preservationSha256: "c".repeat(64),
  files: {
    "https_broker.py": consumer,
    "https-preview.py": consumer,
    "host_config.py": consumer,
    "channel_identity.py": { ...consumer, expected: { kind: "absent" } },
  },
});
export const brokerDeploymentReviewFixture = PreviewBrokerDeploymentJobSchema.parse({
  ...brokerReviewFixture,
  target: "preview-broker-deployment",
  operation: "preview-broker-consumer-deployment",
  reason: "Replace the reviewed broker consumers",
  detail: "Eight fixed consumer files",
  plan: {
    version: 1,
    operation: "preview-broker-consumer-deployment",
    id,
    installationId: brokerReviewFixture.plan.installationId,
    sourceCommit: "c".repeat(40),
    evidenceDirectory: `/protected/evidence/${id}`,
    evidenceDirectoryIdentity: [1, 2, 501, 20, 0o700],
    bootUUID: brokerReviewFixture.plan.installationId,
    targets: [target("/protected/native"), target("/protected/dev")],
    registrations: ["native", "dev"].map((label) => ({
      label,
      root: `/protected/${label}`,
      domain: "gui/501",
      enabled: true,
      override: "absent",
      plist: { path: `/protected/${label}.plist`, sha256: "d".repeat(64) },
      disposition: "absent",
      process: null,
    })),
    participantEvidence: [{ path: "/protected/participants.json", sha256: "d".repeat(64) }],
    manualParticipants: [],
  },
});
