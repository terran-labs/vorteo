import { describe, expect, it } from "vitest";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { describeConfigurationChanges } from "./configuration-change-descriptions";

describe("describeConfigurationChanges", () => {
  it("separates supervisor plan configuration from approval to replace it", () => {
    const value = {
      node: "/protected/bin/node",
      script: "/protected/supervisor-plan.mjs",
      sha256: "a".repeat(64),
    };
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "supervisorMaintenance", value }],
      } as CoordinatorBootstrapPlan),
    ).toEqual([
      `Configure Dev supervisor maintenance plan ${value.sha256}. Replacing the supervisor still requires a separate tracked approval.`,
    ]);
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "supervisorMaintenance", value: null }],
      } as CoordinatorBootstrapPlan),
    ).toEqual(["Remove the tracked Dev supervisor maintenance plan."]);
  });
  it("distinguishes the updater executable from a running supervisor replacement", () => {
    expect(
      describeConfigurationChanges({
        configurationChanges: [
          { setting: "containerSourceUpdateNode", value: "/durable/bin/node" },
        ],
      } as CoordinatorBootstrapPlan),
    ).toEqual([
      "Use /durable/bin/node for subsequent Dev source updates. This does not replace the running supervisor or restart Dev.",
    ]);
  });
  it("describes a listed change exactly like its legacy field", () => {
    const launcher = { candidate: "/fixture/candidate.plist", sha256: "c".repeat(64) };
    const legacy = describeConfigurationChanges({
      hostLauncherUpdateConfiguration: launcher,
    } as CoordinatorBootstrapPlan);
    const listed = describeConfigurationChanges({
      configurationChanges: [{ setting: "hostLauncherUpdate", value: launcher }],
    } as CoordinatorBootstrapPlan);
    expect(listed).toEqual(legacy);
    expect(listed[0]).toContain("Candidate launcher cccccccccccc");
  });

  it("shows everything a Dev boot-entry switch plan authorizes", () => {
    const forward = {
      docker: "/fixture/docker",
      socket: "/fixture/docker.sock",
      container: "a".repeat(64),
      current: {
        pointer: { path: "/etc/paseo-server-entry", sha256: "b".repeat(64) },
        entry: { path: "/opt/factory-entry.mjs", sha256: "c".repeat(64) },
      },
      target: {
        path: "/opt/vorteo-boot/plain.mjs",
        sha256: "d".repeat(64),
        source: "/Users/owner/plain.mjs",
      },
      node: { path: "/fixture/node", sha256: "e".repeat(64) },
      supervisorEntry: { path: "/fixture/supervisor.js", sha256: "f".repeat(64) },
      supervisor: { config: "/fixture/supervisord.conf", program: "paseo" },
      expectBootForm: "plain",
      factoryVerify: {
        script: "/fixture/v4.sh",
        sha256: "1".repeat(64),
        lockInode: 1,
        ownerMode: "paused",
      },
    } as const;
    const describePlan = (value: unknown) =>
      describeConfigurationChanges({
        configurationChanges: [{ setting: "bootEntrySwitch", value }],
      } as CoordinatorBootstrapPlan)[0]!;
    const shown = describePlan(forward);
    // Both full digests, both paths, the Host file root copies, and the direction.
    for (const part of [
      "d".repeat(64),
      "c".repeat(64),
      forward.target.path,
      forward.current.entry.path,
      forward.target.source,
      "without Factory's launcher",
      "plain boot form",
    ])
      expect(shown).toContain(part);
    const rollback = describePlan({
      ...forward,
      current: { ...forward.current, entry: { path: forward.target.path, sha256: "d".repeat(64) } },
      target: { path: forward.current.entry.path, sha256: "c".repeat(64) },
      expectBootForm: "launcher",
    });
    for (const part of [
      "rollback to Factory's launcher",
      "nothing is copied",
      "launcher boot form",
    ])
      expect(rollback).toContain(part);
    expect(rollback).not.toContain(forward.target.source);
  });

  it("describes removal and states why an invalid plan cannot be approved", () => {
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "factoryGate", value: null }],
      } as CoordinatorBootstrapPlan),
    ).toEqual(["Stop running Factory's checks around Dev restarts."]);
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "unknown", value: 1 }],
      } as CoordinatorBootstrapPlan),
    ).toEqual(["This plan cannot be approved: Unknown configuration setting: unknown."]);
  });
  it("describes telemetry enablement and removal without claiming retained logs are deleted", () => {
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "operationalTelemetryEnabled", value: true }],
      } as CoordinatorBootstrapPlan),
    ).toEqual([
      "Turn on private minute-by-minute coordinator performance logging, up to 12 MiB. Records process CPU and memory, cached queue and connection health, and fixed operation status labels; no prompts or account content.",
    ]);
    expect(
      describeConfigurationChanges({
        configurationChanges: [{ setting: "operationalTelemetryEnabled", value: null }],
      } as CoordinatorBootstrapPlan),
    ).toEqual(["Turn off future coordinator performance samples. Keep retained private logs."]);
  });
});
