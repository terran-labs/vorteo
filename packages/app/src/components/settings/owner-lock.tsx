import { useCallback, useMemo, useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { Lock } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useOwnerAccess } from "@/execution-installation/owner-access";
import { isWeb } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import { SettingsCard, SettingsRow } from ".";

const dialogHeader = { title: "Unlock settings" };
const disabledState = { disabled: true };
// Native accessibility hiding does not remove web descendants from the tab order.
const peekWebProps = isWeb ? ({ "aria-hidden": true, inert: true } as const) : {};
const LockIcon = withUnistyles(Lock, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export function OwnerUnlockDialog({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const access = useOwnerAccess();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!visible) {
      setPassword("");
      setError(null);
    }
  }, [visible]);
  useEffect(() => {
    if (visible && access.status === "unlocked") onClose();
  }, [visible, access.status, onClose]);
  const message = error ?? access.error;
  const busy = pending || access.busy;
  const unlock = useCallback(async () => {
    if (busy || !password.trim()) return;
    setPending(true);
    setError(null);
    try {
      await access.unlock(password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not unlock settings.");
    } finally {
      setPending(false);
    }
  }, [busy, password, access]);
  return (
    <AdaptiveModalSheet visible={visible} onClose={onClose} header={dialogHeader}>
      <View style={styles.dialog}>
        <Text style={settingsStyles.rowHint}>
          The host installer generated your owner password on the computer hosting Vorteo.
        </Text>
        <Field label="Owner password">
          <FormTextInput
            key={String(visible)}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            initialValue=""
            onChangeText={setPassword}
            onSubmitEditing={unlock}
            editable={!busy}
            accessibilityLabel="Owner password"
          />
        </Field>
        <OwnerErrorSlot message={message} testID="owner-unlock-error" />
        <Button disabled={busy || !password.trim()} onPress={unlock}>
          Unlock
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

/** Keep error space stable while allowing larger text and full screen reader output. */
function OwnerErrorSlot({ message, testID }: { message: string | null; testID: string }) {
  const { fontScale } = useWindowDimensions();
  return (
    <View style={styles.errorSlot(fontScale)} testID={`${testID}-slot`}>
      <Text
        testID={testID}
        numberOfLines={2}
        accessibilityLiveRegion={message ? "polite" : undefined}
        style={styles.error}
      >
        {message || " "}
      </Text>
    </View>
  );
}

const badgeLabels = {
  none: "",
  checking: "Checking",
  locked: "Locked",
  unlocked: "Unlocked",
};
export function OwnerLockBadge() {
  const access = useOwnerAccess();
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);
  const [error, setError] = useState<string | null>(null);
  const unlocked = access.status === "unlocked";
  const lock = useCallback(async () => {
    setError(null);
    try {
      await access.lock();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not lock settings.");
    }
  }, [access]);
  if (access.status === "none") return null;
  return (
    <View>
      <View style={styles.badge} testID="owner-lock-badge">
        <LockIcon size={16} />
        <Text style={styles.badgeLabel}>{badgeLabels[access.status]}</Text>
        <Button
          variant="ghost"
          disabled={access.busy || access.status === "checking"}
          onPress={unlocked ? lock : openDialog}
        >
          {unlocked ? "Lock" : "Unlock"}
        </Button>
      </View>
      <OwnerErrorSlot message={error} testID="owner-lock-error" />
      <OwnerUnlockDialog visible={open} onClose={closeDialog} />
    </View>
  );
}

interface OwnerLockedGroupProps {
  title: string;
  /** Evaluated only when unlocked or explicitly peeked. Disable queries in peek mode. */
  children: (access: { disabled: boolean }) => ReactNode;
}
export function OwnerLockedGroup({ title, children }: OwnerLockedGroupProps) {
  const access = useOwnerAccess();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const checking = access.status === "checking";
  const disclosureState = useMemo(() => ({ expanded, disabled: checking }), [expanded, checking]);
  if (access.status === "none" || access.status === "unlocked")
    return children({ disabled: false });
  return (
    <View>
      <SettingsCard>
        <View style={styles.lockedRow}>
          <SettingsRow
            label={`${title} · ${checking ? "Checking" : "Locked"}`}
            hint="Enter the owner password to change these settings"
          >
            <Button disabled={checking || access.busy} onPress={openDialog}>
              Unlock
            </Button>
          </SettingsRow>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Peek at ${title}`}
            accessibilityState={disclosureState}
            disabled={checking}
            onPress={toggle}
            style={styles.disclosure}
          >
            <Text style={settingsStyles.rowHint}>
              {expanded ? "Hide settings" : "Peek at settings"}
            </Text>
          </Pressable>
        </View>
      </SettingsCard>
      {!checking && expanded ? (
        <View
          {...peekWebProps}
          testID="owner-locked-peek"
          pointerEvents="none"
          accessibilityElementsHidden
          accessibilityState={disabledState}
          importantForAccessibility="no-hide-descendants"
          style={styles.disabled}
        >
          {children({ disabled: true })}
        </View>
      ) : null}
      <OwnerUnlockDialog visible={open} onClose={closeDialog} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dialog: { gap: theme.spacing[3] },
  errorSlot: (fontScale: number) => ({ minHeight: theme.fontSize.sm * 1.5 * 2 * fontScale }),
  error: {
    lineHeight: theme.fontSize.sm * 1.5,
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  badge: {
    width: 224,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  badgeLabel: {
    width: 76,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  lockedRow: { minHeight: 112 },
  disclosure: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  disabled: { opacity: 0.45 },
}));
