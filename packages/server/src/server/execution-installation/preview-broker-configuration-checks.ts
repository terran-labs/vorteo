import path from "node:path";
import { PreviewBrokerDeploymentConfigurationSchema } from "@getpaseo/protocol/preview-broker-deployment";
import { PreviewBrokerConfigurationSchema } from "@getpaseo/protocol/preview-broker-maintenance";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import type { InstallationConfig } from "./config.js";

/** The two coordinator configuration keys that name the preview broker's executables. */
export type BrokerSetting = "previewBrokerDeployment" | "previewBroker";

/**
 * What a broker configuration must bind to, chosen by the reviewing side and never by the
 * proposal: the paired Docker endpoint and Dev container, and the coordinator release whose
 * journal readers recover broker jobs.
 */
export interface BrokerBindingPins {
  docker: string;
  socket: string;
  containerId: string;
  recovery: { directory: string; node: { path: string; sha256: string } };
}

/**
 * Refuses a broker configuration that does not bind the pinned Docker endpoint, Dev container
 * and retained recovery readers. Shared by the coordinator bootstrap review and the reviewed
 * coordinator settings writer.
 */
export function verifyBrokerBinding(
  setting: BrokerSetting,
  value: unknown,
  pins: BrokerBindingPins,
): void {
  const broker =
    setting === "previewBrokerDeployment"
      ? PreviewBrokerDeploymentConfigurationSchema.parse(value)
      : PreviewBrokerConfigurationSchema.parse(value);
  const directory = path.join(
    pins.recovery.directory,
    "packages/server/dist/server/server/execution-installation",
  );
  if (
    broker.docker !== pins.docker ||
    broker.socket !== pins.socket ||
    broker.containerId !== pins.containerId ||
    broker.recovery.node.path !== pins.recovery.node.path ||
    broker.recovery.node.sha256 !== pins.recovery.node.sha256 ||
    broker.recovery.journal.path !== path.join(directory, "lifecycle-journal.js") ||
    broker.recovery.queue.path !== path.join(directory, "restarts.js") ||
    broker.recovery.configModule.path !== path.join(directory, "config.js")
  )
    throw new BootstrapRequestConflict(
      setting === "previewBrokerDeployment"
        ? "Consumer deployment must bind exact container and recovery readers"
        : "Broker configuration must bind exact paired container and retained recovery readers",
    );
}

/**
 * An attached broker section must pass its executor's own protected-file, hash-pin, scope and
 * recovery reader checks, read from the candidate configuration. The executors repeat them
 * before every broker effect.
 */
export async function verifyBrokerExecutorInputs(input: {
  settings: readonly BrokerSetting[];
  config: InstallationConfig;
  /** The candidate configuration file and its digest, which the deployment executor rereads. */
  configurationFile: { path: string; sha256: string };
  writableMountRoots(): Promise<readonly string[]>;
}): Promise<void> {
  for (const setting of input.settings) {
    if (setting === "previewBrokerDeployment") {
      const { createPreviewBrokerDeploymentExecutor } =
        await import("./preview-broker-deployment-executor.js");
      const executor = createPreviewBrokerDeploymentExecutor({
        config: input.config,
        configurationFile: input.configurationFile,
        assertActive() {},
        writableMountRoots: input.writableMountRoots,
      });
      if (!(await executor.brokerDeploymentCompatible()))
        throw new BootstrapRequestConflict(
          "Consumer deployment configuration fails its protected input or recovery reader checks",
        );
    } else {
      const { createPreviewBrokerExecutor } = await import("./preview-broker-executor.js");
      const executor = createPreviewBrokerExecutor({
        config: input.config,
        writableMountRoots: input.writableMountRoots,
      });
      if (!(await executor.brokerCompatible()))
        throw new BootstrapRequestConflict(
          "Broker configuration fails its protected input or recovery reader checks",
        );
    }
  }
}
