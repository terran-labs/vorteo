import { useHostFeature } from "@/runtime/host-features";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { RestartRecoveryCard } from "../restart-recovery-card";
import { IdleRuntimeCleanupCard } from "../idle-runtime-cleanup-card";

/**
 * How much a Host restart costs: whether interrupted agents resume afterwards and whether idle
 * agents release their processes. It sits beside the Restart action because both change what a
 * restart interrupts. Hosts that support neither setting show nothing.
 */
export function RestartBehaviorSection({ serverId }: { serverId: string }) {
  const resume = useHostFeature(serverId, "resumeOnStartupSetting");
  const idle = useHostFeature(serverId, "idleRuntimeCleanupSetting");
  if (!resume && !idle) return null;
  return (
    <SettingsSection title="When the Host restarts" testID="system-restart-behavior">
      <RestartRecoveryCard serverId={serverId} />
      <IdleRuntimeCleanupCard serverId={serverId} />
    </SettingsSection>
  );
}
