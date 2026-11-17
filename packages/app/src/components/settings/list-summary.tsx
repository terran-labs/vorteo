import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { SettingsCard, SettingsRow } from "./index";

const CloseDialogContext = createContext<() => void>(() => {});

/**
 * Closes the enclosing settings dialog, or does nothing outside one. Rows that navigate away, such
 * as a project that opens its own page, call it first so the dialog does not stay over the new page.
 * Rows that open their own editor dialog call it first too, so two dialogs never stack: focus moves
 * to the list's Manage button before the editor opens, and the editor returns focus there.
 */
export function useCloseSettingsDialog(): () => void {
  return useContext(CloseDialogContext);
}

// React Native Web drops `accessibilityHint`; `aria-haspopup` tells web screen readers a dialog
// opens. React Native's types omit the attribute.
const DIALOG_TRIGGER = { "aria-haspopup": "dialog" } as object;

/** How many items a list shows in place before it collapses into a summary. */
export const SETTINGS_LIST_INLINE_LIMIT = 5;

/** Desktop width for dialogs that hold a full settings editor. */
const EDITOR_DIALOG_WIDTH = 760;

export interface SettingsDialogRowProps {
  /** The row's title, such as an environment name. */
  label: string;
  /** Passive status or detail under the title. */
  hint?: ReactNode;
  /** The row button's text. Defaults to "Edit". */
  actionLabel?: string;
  /** The button's accessible name. Defaults to "<actionLabel> <label>". */
  actionAccessibilityLabel?: string;
  /** The dialog title. Defaults to `label`. */
  dialogTitle?: string;
  /** Other controls in the row, placed before the button. */
  accessory?: ReactNode;
  /** The full editor. Mounted while the dialog is open or closing. */
  children: ReactNode;
  /** Controls the dialog, for example to open it from a deep link. Uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testID?: string;
}

/**
 * A settings row that opens its full editor in a dialog: a bottom sheet on compact layouts and a
 * centered card on desktop. Focus returns to the row's button when the dialog closes. Render it
 * inside a `SettingsCard`.
 */
export function SettingsDialogRow({
  label,
  hint,
  actionLabel = "Edit",
  actionAccessibilityLabel,
  dialogTitle,
  accessory,
  children,
  open: openProp,
  onOpenChange,
  testID,
}: SettingsDialogRowProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const trigger = useRef<View>(null);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  // Content stays mounted until the sheet finishes closing, so the closing sheet is never empty.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const unmount = useCallback(() => setMounted(false), []);
  const show = useCallback(() => setOpen(true), [setOpen]);
  const close = useCallback(() => {
    // Focus the button first, synchronously: an editor a row opens next records it as the place
    // to return focus. The frame retry covers the sheet restoring focus as it closes.
    if (isWeb) {
      const focusTrigger = () => (trigger.current as unknown as HTMLElement | null)?.focus?.();
      focusTrigger();
      requestAnimationFrame(focusTrigger);
    }
    setOpen(false);
  }, [setOpen]);
  const title = dialogTitle ?? label;
  const header = useMemo(() => ({ title }), [title]);
  const expandedState = useMemo(() => ({ expanded: open }), [open]);
  return (
    <SettingsRow label={label} hint={hint} testID={testID}>
      <View style={styles.actions}>
        {accessory}
        <Button
          ref={trigger}
          variant="outline"
          onPress={show}
          accessibilityLabel={actionAccessibilityLabel ?? `${actionLabel} ${label}`}
          accessibilityHint="Opens a dialog"
          {...DIALOG_TRIGGER}
          accessibilityState={expandedState}
          aria-expanded={open}
          testID={testID ? `${testID}-open` : undefined}
        >
          {actionLabel}
        </Button>
      </View>
      <AdaptiveModalSheet
        visible={open}
        onClose={close}
        onDismiss={unmount}
        header={header}
        accessibilityLabel={title}
        desktopMaxWidth={EDITOR_DIALOG_WIDTH}
        testID={testID ? `${testID}-dialog` : undefined}
      >
        {open || mounted ? (
          <CloseDialogContext.Provider value={close}>{children}</CloseDialogContext.Provider>
        ) : null}
      </AdaptiveModalSheet>
    </SettingsRow>
  );
}

export interface SettingsListSummaryProps {
  /** The list's name, used as the dialog title, such as "Personal skills". */
  title: string;
  /** How many items the full list holds. */
  count: number;
  /** Item noun for the summary, such as `{ one: "skill", other: "skills" }`. */
  noun: { one: string; other: string };
  /** A few item names shown under the count. The rest are summarized as "and N more". */
  preview?: readonly string[];
  /** Extra passive detail appended to the preview line, such as "2 disabled". */
  detail?: string;
  /** Lists at or under this size render in place. Defaults to `SETTINGS_LIST_INLINE_LIMIT`. */
  inlineLimit?: number;
  /** The button's text. Defaults to "Manage". */
  actionLabel?: string;
  /** Controls kept in the summary row, such as an Add button, placed before Manage. */
  accessory?: ReactNode;
  /** The full list with its editing controls: inline when short, in the dialog when long. */
  children: ReactNode;
  testID?: string;
}

const PREVIEW_NAMES = 3;

function previewLine(preview: readonly string[] | undefined, count: number, detail?: string) {
  const parts: string[] = [];
  if (preview?.length) {
    const shown = preview.slice(0, PREVIEW_NAMES);
    const rest = count - shown.length;
    parts.push(rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", "));
  }
  if (detail) parts.push(detail);
  return parts.length ? parts.join(". ") : undefined;
}

/**
 * Keeps long lists off the top level of settings. A short list renders in place; a long one
 * becomes a single summary row with a count, a few names and a Manage button that opens the
 * full list in a dialog. Use it for every settings list that can grow without bound.
 *
 * The layout is decided once per mount, when the first items arrive, so editing never swaps
 * it: a removal inside Manage keeps the dialog open, and an addition never pulls a focused
 * inline row into a dialog. The next visit to the page decides again.
 */
export function SettingsListSummary({
  title,
  count,
  noun,
  preview,
  detail,
  inlineLimit = SETTINGS_LIST_INLINE_LIMIT,
  actionLabel = "Manage",
  accessory,
  children,
  testID,
}: SettingsListSummaryProps) {
  const [summarized, setSummarized] = useState(count > inlineLimit);
  const decided = useRef(count > 0);
  useEffect(() => {
    if (decided.current || count === 0) return;
    decided.current = true;
    setSummarized(count > inlineLimit);
  }, [count, inlineLimit]);
  if (!summarized) return children;
  const label = `${count} ${count === 1 ? noun.one : noun.other}`;
  return (
    <SettingsCard testID={testID}>
      <SettingsDialogRow
        label={label}
        hint={previewLine(preview, count, detail)}
        actionLabel={actionLabel}
        actionAccessibilityLabel={`${actionLabel} ${title.toLowerCase()}`}
        dialogTitle={title}
        accessory={accessory}
        testID={testID ? `${testID}-summary` : undefined}
      >
        {children}
      </SettingsDialogRow>
    </SettingsCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
