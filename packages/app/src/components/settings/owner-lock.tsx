import { PasswordFileHint } from "@/execution-installation/panel";
import { useCallback, useMemo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
} from "react-native";
import { Lock, LockOpen } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useOwnerAccess } from "@/execution-installation/owner-access";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { hoverStyle } from "@/styles/hover";
import { settingsStyles } from "@/styles/settings";
import { SettingsCard, SettingsRow } from ".";

const dialogHeader = { title: "Unlock settings" };
const disabledState = { disabled: true };
// Native accessibility hiding does not remove web descendants from the tab order.
const PEEK_FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const LockIcon = withUnistyles(Lock, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const SelectedLockIcon = withUnistyles(Lock, (theme) => ({ color: theme.colors.foreground }));
const UnlockIcon = withUnistyles(LockOpen, (theme) => ({ color: theme.colors.foregroundMuted }));
const SelectedUnlockIcon = withUnistyles(LockOpen, (theme) => ({
  color: theme.colors.foreground,
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
            testID="installation-password"
            accessibilityLabel="Owner password"
          />
        </Field>
        {access.passwordFile ? (
          <>
            <Text testID="installation-password-file" selectable style={settingsStyles.rowHint}>
              {access.passwordFile}
            </Text>
            <PasswordFileHint passwordFile={access.passwordFile} wide={false} />
          </>
        ) : null}
        <OwnerErrorSlot message={message} testID="owner-unlock-error" />
        <Button testID="installation-unlock" disabled={busy || !password.trim()} onPress={unlock}>
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
        // Always live, so the first message after mount is announced too.
        accessibilityLiveRegion="polite"
        style={styles.error}
      >
        {message || " "}
      </Text>
    </View>
  );
}

type LockChoice = "locked" | "unlocked";

/** Announced when the state changes; worded unlike the radio labels so tests can tell them apart. */
const statusAnnouncements = {
  none: "",
  checking: "Checking settings lock",
  locked: "Settings are locked",
  unlocked: "Settings are unlocked",
};

/**
 * Locks or unlocks the owner settings: a Locked / Unlocked radio group spanning its container.
 * Choosing Unlocked opens the password dialog and choosing Locked locks at once, so the radio
 * shows the real state rather than a request. While the state is being checked neither option is
 * chosen and both are disabled. Arrow keys move between the two options and choose, as in any
 * radio group; only the chosen option is a Tab stop.
 */
export function OwnerLockBadge({ testIDPrefix = "owner-access" }: { testIDPrefix?: string } = {}) {
  const access = useOwnerAccess();
  const compact = useIsCompactFormFactor();
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);
  const [error, setError] = useState<string | null>(null);
  const radios = useRef<Record<LockChoice, View | null>>({ locked: null, unlocked: null });
  const radioRefs = useMemo(
    () => ({
      locked: (node: View | null) => {
        radios.current.locked = node;
      },
      unlocked: (node: View | null) => {
        radios.current.unlocked = node;
      },
    }),
    [],
  );
  const checking = access.status === "checking";
  const current: LockChoice | null =
    access.status === "locked" || access.status === "unlocked" ? access.status : null;
  const disabled = checking || access.busy;
  const lock = useCallback(async () => {
    setError(null);
    try {
      await access.lock();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not lock settings.");
    }
  }, [access]);
  // Space and the option's own press can both arrive for one key; lock only once.
  const locking = useRef(false);
  const choose = useCallback(
    (choice: LockChoice) => {
      if (disabled || choice === current) return;
      if (choice === "unlocked") return openDialog();
      if (locking.current) return;
      locking.current = true;
      void lock().finally(() => {
        locking.current = false;
      });
    },
    [current, disabled, lock, openDialog],
  );
  // Arrows only move focus between the two options. Choosing locks at once or opens the
  // password dialog, so it waits for Space or Enter, never for an arrow.
  const handleKeyDown = useCallback(
    (event: { key: string; preventDefault(): void }) => {
      if (disabled) return;
      const node = (choice: LockChoice) => radios.current[choice] as unknown as HTMLElement | null;
      const focused: LockChoice =
        typeof document !== "undefined" && document.activeElement === node("unlocked")
          ? "unlocked"
          : "locked";
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        // Two options: every arrow moves to the other one.
        node(focused === "locked" ? "unlocked" : "locked")?.focus?.();
      } else if (event.key === " ") {
        event.preventDefault();
        choose(focused);
      }
    },
    [choose, disabled],
  );
  const groupWebProps = useMemo(
    () =>
      isWeb
        ? ({ role: "radiogroup", "aria-label": "Settings lock", onKeyDown: handleKeyDown } as const)
        : null,
    [handleKeyDown],
  );
  const announcement = useLockAnnouncement(access.status);
  const segmentsStyle = useMemo(
    () => [styles.segments, compact && styles.segmentsTouch],
    [compact],
  );
  if (access.status === "none") return null;
  return (
    <View style={styles.lockControl}>
      <View
        {...groupWebProps}
        accessibilityRole="radiogroup"
        accessibilityLabel="Settings lock"
        style={segmentsStyle}
        testID="owner-lock-badge"
      >
        {(["locked", "unlocked"] as const).map((choice) => (
          <LockRadio
            key={choice}
            choice={choice}
            checked={current === choice}
            // The chosen option is the Tab stop; with none chosen, Locked is.
            tabStop={current ? current === choice : choice === "locked"}
            disabled={disabled}
            touch={compact}
            onChoose={choose}
            radioRef={radioRefs[choice]}
            testID={lockRadioTestID(testIDPrefix, choice, current)}
          />
        ))}
        {/* Why neither option is chosen yet; not live, so arriving is quiet. */}
        {checking ? <Text style={styles.visuallyHidden}>Checking</Text> : null}
      </View>
      {/* Outside the radiogroup, and silent until the state changes after first settling. */}
      <Text accessibilityLiveRegion="polite" style={styles.visuallyHidden}>
        {announcement}
      </Text>
      <OwnerErrorSlot message={error} testID="owner-lock-error" />
      <OwnerUnlockDialog visible={open} onClose={closeDialog} />
    </View>
  );
}

/**
 * What the live region says: nothing on arrival, even as the first check settles, then each
 * later change, so visiting settings does not announce the lock every time.
 */
function useLockAnnouncement(status: keyof typeof statusAnnouncements): string {
  const settled = useRef<string | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (status === "checking" || status === "none") return;
    if (settled.current !== null && settled.current !== status)
      setText(statusAnnouncements[status]);
    settled.current = status;
  }, [status]);
  return text;
}

/** Keeps the ids existing browser tests use for the action each option performs. */
function lockRadioTestID(prefix: string, choice: LockChoice, current: LockChoice | null): string {
  if (choice === "locked") return current === "unlocked" ? `${prefix}-lock` : `${prefix}-locked`;
  return current === "unlocked" ? `${prefix}-unlocked` : `${prefix}-owner-unlock`;
}

function LockRadio({
  choice,
  checked,
  tabStop,
  disabled,
  touch,
  onChoose,
  radioRef,
  testID,
}: {
  choice: LockChoice;
  checked: boolean;
  tabStop: boolean;
  disabled: boolean;
  touch: boolean;
  onChoose: (choice: LockChoice) => void;
  radioRef: (node: View | null) => void;
  testID: string;
}) {
  const press = useCallback(() => onChoose(choice), [choice, onChoose]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const style = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.segment,
      touch && styles.segmentTouch,
      checked && styles.segmentChecked,
      !checked && !disabled && (pressed ? styles.segmentPressed : styles.segmentHover),
      disabled && styles.segmentDisabled,
    ],
    [checked, disabled, touch],
  );
  const labelStyle = useMemo(
    () => [styles.segmentLabel, checked && styles.segmentLabelChecked],
    [checked],
  );
  const label = choice === "locked" ? "Locked" : "Unlocked";
  let Icon = choice === "locked" ? LockIcon : UnlockIcon;
  if (checked) Icon = choice === "locked" ? SelectedLockIcon : SelectedUnlockIcon;
  return (
    <Pressable
      ref={radioRef}
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      aria-checked={checked}
      // One Tab stop per group. react-native-web's Pressable ignores `focusable`, so set tabIndex.
      tabIndex={tabStop && !disabled ? 0 : -1}
      disabled={disabled}
      onPress={press}
      style={style}
      testID={testID}
    >
      <Icon size={14} />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A locked group's preview: readable by everyone, operable by no one. Screen readers can read
 * it, since the toggle says it is shown, but pointer input is off and every control inside
 * leaves the Tab order and reports disabled.
 */
function PeekPreview({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (!isWeb) return;
    const node = ref.current as unknown as HTMLElement | null;
    // Runs after every render, so controls the preview adds later are covered too.
    for (const control of node?.querySelectorAll<HTMLElement>(PEEK_FOCUSABLE) ?? []) {
      control.tabIndex = -1;
      control.setAttribute("aria-disabled", "true");
    }
  });
  const webGroup = useMemo(
    () =>
      isWeb ? ({ role: "group", "aria-label": `${title} preview, read only` } as const) : null,
    [title],
  );
  return (
    <View
      {...webGroup}
      ref={ref}
      testID="owner-locked-peek"
      pointerEvents="none"
      accessibilityState={disabledState}
      style={styles.disabled}
    >
      {children}
    </View>
  );
}

/** Safe default for panes whose children start owner queries on mount. */
export function OwnerSettingsGate({
  title,
  children,
  preview,
  required = true,
}: {
  required?: boolean;
  title: string;
  children: ReactNode;
  preview?: ReactNode;
}) {
  const render = useCallback(
    ({ disabled }: { disabled: boolean }) => {
      if (disabled)
        return (
          preview ?? <Text style={settingsStyles.rowHint}>Unlock to load these settings.</Text>
        );
      return children;
    },
    [children, preview],
  );
  if (!required) return children;
  return <OwnerLockedGroup title={title}>{render}</OwnerLockedGroup>;
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
  // Unlock removes the dialog subtree before its close effect can run.
  // Reset local presentation state here so a later Lock starts collapsed.
  useEffect(() => {
    setOpen(false);
    setExpanded(false);
  }, [access.status]);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const checking = access.status === "checking";
  const disclosureState = useMemo(() => ({ expanded, disabled: checking }), [expanded, checking]);
  const webDisclosureProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
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
            <Button
              disabled={checking || access.busy}
              onPress={openDialog}
              accessibilityLabel={`Unlock ${title}`}
            >
              Unlock
            </Button>
          </SettingsRow>
          <Pressable
            {...webDisclosureProps}
            accessibilityRole="button"
            // The name starts with the visible text, so voice control can say what it sees.
            accessibilityLabel={`${expanded ? "Hide settings" : "Peek at settings"} for ${title}`}
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
        <PeekPreview title={title}>{children({ disabled: true })}</PeekPreview>
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
  // Spans its container, so the two options sit centered under the sidebar or card above.
  lockControl: { alignSelf: "stretch" },
  segments: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[1],
    padding: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  segmentsTouch: { padding: 0, borderWidth: 0 },
  segment: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    minHeight: 30,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    // Every option keeps a border, so marking the chosen one never shifts the labels.
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    _web: {
      "_is(:focus-visible)": {
        outlineStyle: "solid",
        outlineWidth: 2,
        outlineColor: theme.colors.accent,
        outlineOffset: 1,
      },
    },
  },
  // Touch layouts keep a full 44 point target per option.
  segmentTouch: { minHeight: 44 },
  // Fill alone is too close to the track in light themes; the outline and weight mark the choice
  // in every theme.
  segmentChecked: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.foregroundMuted,
  },
  segmentPressed: { backgroundColor: theme.colors.surface3 },
  segmentHover: hoverStyle({ backgroundColor: theme.colors.surface2 }),
  segmentDisabled: { opacity: 0.5 },
  segmentLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  segmentLabelChecked: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  // Read by screen readers, invisible on screen.
  visuallyHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    opacity: 0,
  },
  lockedRow: { minHeight: 112 },
  disclosure: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  disabled: { opacity: 0.45 },
}));
