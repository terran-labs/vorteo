import {
  findInstallationEnvironment,
  readExecutionInstallation,
} from "@/execution-installation/policy";
import { OwnerSettingsGate } from "@/components/settings/owner-lock";
import { CopyField } from "@/components/settings/copy-field";
import { installationConnectionStatus, type ConnectionStatus } from "./claude-connection-status";
import { claudeProviderConnectsToInstallation } from "./claude-setup-login";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AccessibilityInfo, Text, View, findNodeHandle } from "react-native";
import { AlertTriangle, CheckCircle2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  useClaudeSignInUpgradeAvailable,
  useProviderLogin,
  useSharedInstallationSignIn,
} from "./use-provider-login";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { ActionFooter, ActionFooterLeading } from "@/components/ui/action-footer";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { controlHeightForLayout } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useSessionStore } from "@/stores/session-store";
import { useRefreshAfterSignIn } from "./refresh-after-sign-in";
import { openExternalUrl } from "@/utils/open-external-url";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { Theme } from "@/styles/theme";

/** What a connect dialog achieved, reported when it closes. */
export type ConnectionOutcome = "connected" | "cancelled" | "failed";

interface LoginPanelProps {
  serverId: string | null;
  providerId: string;
  name: string;
  provider?: "codex" | "claude";
  /**
   * Reports the latest outcome as the sign-in progresses: connected, failed, or null while
   * nothing has finished. The dialog turns the last report into its close result.
   */
  onOutcome?: (outcome: Exclude<ConnectionOutcome, "cancelled"> | null) => void;
  /** Moves focus to the sign-in button once it is ready, such as right after account creation. */
  focusSignIn?: boolean;
  /**
   * The status line's `nativeID`, so the dialog can name it as its description and the code
   * field can point at it for errors. Generated when omitted.
   */
  statusId?: string;
}

export function ProviderLoginPanel(props: LoginPanelProps) {
  return (
    <OwnerSettingsGate
      title="Provider sign-in"
      required={
        findInstallationEnvironment(readExecutionInstallation(), props.serverId ?? "") !== null
      }
    >
      <UnlockedProviderLoginPanel {...props} />
    </OwnerSettingsGate>
  );
}

function UnlockedProviderLoginPanel(props: LoginPanelProps) {
  const { serverId, provider = "codex", providerId } = props;
  const supported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerAccountLogin === true,
  );
  const claudeSupported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.claudeAccountCreation === true,
  );
  const permissions = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.permissions,
  );
  const canManage = permissions?.includes("daemon.manage") !== false;
  // Installation accounts sign in through the coordinator, whichever environment opened this.
  const shared = useSharedInstallationSignIn(serverId, provider, providerId);
  if (!shared && (!supported || (provider === "claude" && !claudeSupported)))
    return <Text style={styles.text}>Update this host to connect accounts here.</Text>;
  if (!shared && !canManage)
    return (
      <Text style={styles.text}>Connecting an account needs permission to manage this host.</Text>
    );
  return <LoginPanelContent {...props} />;
}

function LoginPanelContent(props: LoginPanelProps) {
  const { provider = "codex", serverId, providerId } = props;
  const shared = useSharedInstallationSignIn(serverId, provider, providerId);
  if (provider === "claude" && shared && !claudeProviderConnectsToInstallation(providerId))
    return (
      <Text style={styles.text}>
        This connection uses the Claude CLI login on this machine. To connect Claude for the whole
        installation, use Add connection in Accounts &amp; profiles.
      </Text>
    );
  return <AccountLoginContent {...props} />;
}

type Login = ReturnType<typeof useProviderLogin>;
type LoginStatus = ProviderLoginState["status"];
type Requested = "start" | "cancel" | "sign-out" | "submit";
type Flow = "connect" | "upgrade";

interface LayoutProps {
  login: Login;
  /** A setup-token Claude account's in-place upgrade, when the installation offers one. */
  upgrade: Login | null;
  provider: "codex" | "claude";
  name: string;
  onUpgradeEngaged(engaged: boolean): void;
  onOutcome?: LoginPanelProps["onOutcome"];
  focusSignIn?: boolean;
  statusId?: string;
  serverId: string | null;
  providerId: string;
}

function AccountLoginContent({
  serverId,
  providerId,
  name,
  provider = "codex",
  onOutcome,
  focusSignIn,
  statusId,
}: LoginPanelProps) {
  const login = useProviderLogin(serverId, providerId, provider);
  const upgradeAvailable = useClaudeSignInUpgradeAvailable(serverId, providerId);
  // A running or finished upgrade stays on screen after the account stops offering it.
  const [upgradeEngaged, setUpgradeEngaged] = useState(false);
  const layout = {
    login,
    provider,
    name,
    onUpgradeEngaged: setUpgradeEngaged,
    onOutcome,
    focusSignIn,
    statusId,
    serverId,
    providerId,
  };
  if (login.sharedClaude && (upgradeAvailable || upgradeEngaged))
    return <UpgradeableLogin {...layout} />;
  return <LoginLayout {...layout} upgrade={null} />;
}

function UpgradeableLogin(layout: Omit<LayoutProps, "upgrade">) {
  const upgrade = useProviderLogin(layout.serverId, layout.providerId, "claude", "upgrade");
  return <LoginLayout {...layout} upgrade={upgrade} />;
}

const ACTIVE: ReadonlySet<LoginStatus | undefined> = new Set(["starting", "waiting", "verifying"]);
const ENGAGED: ReadonlySet<LoginStatus | undefined> = new Set([...ACTIVE, "succeeded"]);

/**
 * The connect and reconnect dialog body. Exactly one status line sits at the top and changes in
 * place; a reserved details area holds the sign-in link, code or a one-line hint; actions stay
 * in one row below. Moving between states therefore never shifts the dialog.
 */
function LoginLayout({
  login,
  upgrade,
  provider,
  name,
  onUpgradeEngaged,
  onOutcome,
  focusSignIn,
  statusId: statusIdProp,
  serverId,
  providerId,
}: LayoutProps) {
  const generatedStatusId = `${useId()}-status`;
  const statusId = statusIdProp ?? generatedStatusId;
  const label = provider === "claude" ? "Claude" : "Codex";
  const { flow, current, upgradeEngaged, upgradeStopped } = activeFlow(login, upgrade);
  useEffect(() => onUpgradeEngaged(upgradeEngaged), [upgradeEngaged, onUpgradeEngaged]);
  const state = current.state;

  const [requested, setRequested] = useState<Requested | null>(null);
  const [notice, setNoticeState] = useState<Notice | null>(null);
  // Each notice gets a new sequence, so repeating the same message is announced again.
  const noticeSequence = useRef(0);
  const setNotice = useCallback((text: string | null) => {
    setNoticeState(text ? { text, sequence: ++noticeSequence.current } : null);
  }, []);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const attemptKey = state && "attemptId" in state ? `${state.attemptId}:${state.status}` : null;
  // A new attempt or step retires notices about the previous one.
  useEffect(() => setNotice(null), [attemptKey, flow, setNotice]);
  const root = useRef<View>(null);
  useStepFocus(root, `${flow}:${attemptKey ?? state?.status ?? "loading"}`);

  const outcome = useReportOutcome(login, onOutcome);
  useRefreshAfterSignIn({ login, upgrade, outcome, serverId, providerId });

  const act = useCallback(
    (kind: Requested, run: () => void) => {
      setNotice(null);
      setRequested(kind);
      run();
    },
    [setNotice],
  );
  const submitting = useCallback(() => setRequested("submit"), []);
  const startConnect = useCallback(() => act("start", login.start), [act, login.start]);
  const cancel = useCallback(() => act("cancel", current.cancel), [act, current.cancel]);
  const signOut = useCallback(async () => {
    // The browser confirmation takes focus; give it back to Disconnect afterwards.
    const opener =
      isWeb && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const confirmed = await confirmDialog({
      title: `Disconnect ${label}?`,
      message: "Every environment in this installation loses this sign-in until you connect again.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (opener?.isConnected) opener.focus();
    if (confirmed) act("sign-out", login.signOut);
  }, [act, label, login.signOut]);
  const upgradeStart = upgrade?.start;
  const startUpgrade = useCallback(
    () => upgradeStart && act("start", upgradeStart),
    [act, upgradeStart],
  );

  const status = flowStatus({
    login: current,
    flow,
    label,
    notice,
    requested,
    submitted: state?.status === "waiting" && submitted === state.attemptId,
  });
  const panel = useMemo(
    () => ({ statusId, onNotice: setNotice, onSubmitted: setSubmitted, onSubmitting: submitting }),
    [statusId, setNotice, submitting],
  );
  const waiting = state?.status === "waiting" ? state : null;

  return (
    <PanelContext.Provider value={panel}>
      <View ref={root} style={styles.body} testID="provider-login-panel">
        <StatusLine status={status} nativeID={statusId} />
        <Details>
          {waiting ? (
            <Challenge key={waiting.attemptId} state={waiting} login={current} />
          ) : (
            <Hint
              login={login}
              flow={flow}
              provider={provider}
              name={name}
              upgradeOffered={Boolean(upgrade) && !upgradeEngaged}
            />
          )}
        </Details>
        <ActionFooter style={styles.actions}>
          {waiting || ACTIVE.has(state?.status) ? (
            <ActiveActions
              login={current}
              waiting={waiting}
              onCancel={cancel}
              onNotice={setNotice}
            />
          ) : (
            <IdleActions
              login={login}
              flow={flow}
              label={label}
              upgrade={upgrade}
              upgradeEngaged={upgradeEngaged}
              upgradeStopped={upgradeStopped}
              onStartConnect={startConnect}
              onStartUpgrade={startUpgrade}
              onSignOut={signOut}
              focusSignIn={focusSignIn}
            />
          )}
        </ActionFooter>
      </View>
    </PanelContext.Provider>
  );
}

interface Notice {
  text: string;
  sequence: number;
}

/** What the challenge steps share with the panel without threading every prop. */
const PanelContext = createContext<{
  statusId: string;
  onNotice(text: string | null): void;
  onSubmitted(attemptId: string | null): void;
  onSubmitting(): void;
}>({ statusId: "", onNotice: () => {}, onSubmitted: () => {}, onSubmitting: () => {} });

/**
 * When a step replaces or disables the focused control, focus would fall to the page. After each
 * step change this moves it to the step's primary action, or the status line when there is none.
 * Focus the owner placed elsewhere is left alone. Web only.
 */
function useStepFocus(root: RefObject<View | null>, step: string) {
  useEffect(() => {
    if (!isWeb) return;
    const frame = requestAnimationFrame(() => {
      const scope = root.current as unknown as HTMLElement | null;
      const active = document.activeElement;
      const statusLine = scope?.querySelector<HTMLElement>('[data-testid="provider-login-status"]');
      // Focus parked on the status line by an earlier step moves on with the next one.
      const lost = !active || active === document.body || !active.isConnected;
      if (!scope?.isConnected || (!lost && active !== statusLine)) return;
      const primary = scope.querySelector<HTMLElement>(
        '[data-login-primary="true"]:not([disabled])',
      );
      // The code step's next action is typing, so its field is the primary target.
      const field = primary?.matches("input, textarea")
        ? primary
        : primary?.querySelector<HTMLElement>("input, textarea");
      (field ?? primary ?? statusLine)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [root, step]);
}

/** Marks the step's primary action for step focus; react-native-web renders it as data-*. */
const PRIMARY_ACTION = { dataSet: { loginPrimary: "true" } } as object;

/** The upgrade drives the dialog while it runs, and reports its result until the owner acts. */
function activeFlow(login: Login, upgrade: Login | null) {
  const status = upgrade?.state?.status;
  const upgradeEngaged = ENGAGED.has(status);
  const upgradeStopped =
    status === "failed" ||
    status === "cancelled" ||
    Boolean(upgrade && (upgrade.readFailed || upgrade.actionFailed));
  const onUpgrade =
    upgrade !== null && (upgradeEngaged || (upgradeStopped && !ACTIVE.has(login.state?.status)));
  return {
    flow: (onUpgrade ? "upgrade" : "connect") as Flow,
    current: onUpgrade && upgrade ? upgrade : login,
    upgradeEngaged,
    upgradeStopped,
  };
}

/** Reports connected or failed as the main sign-in settles, for the dialog's close result. */
function useReportOutcome(login: Login, onOutcome: LoginPanelProps["onOutcome"]) {
  const sync = login.synchronization;
  let outcome: "connected" | "failed" | null = null;
  if (login.shared && sync?.connected && !sync.needsSignIn) outcome = "connected";
  else if (!login.shared && login.state?.status === "succeeded") outcome = "connected";
  else if (login.state?.status === "failed" || login.readFailed || login.actionFailed)
    outcome = "failed";
  useEffect(() => onOutcome?.(outcome), [onOutcome, outcome]);
  return outcome;
}

function flowStatus({
  login,
  flow,
  label,
  notice,
  requested,
  submitted,
}: {
  login: Login;
  flow: Flow;
  label: string;
  notice: Notice | null;
  requested: Requested | null;
  submitted: boolean;
}): PanelStatus {
  const upgrade = flow === "upgrade";
  const kept = upgrade ? " Your setup token still works." : "";
  return (
    interruptedStatus(login, upgrade, kept, notice, requested) ??
    stateStatus(login, upgrade, kept, label, submitted)
  );
}

/** Conditions that outrank the attempt's own state: lost connection, errors, pending requests. */
function interruptedStatus(
  login: Login,
  upgrade: boolean,
  kept: string,
  notice: Notice | null,
  requested: Requested | null,
): PanelStatus | null {
  if (!login.connected)
    return { tone: "error", text: "Connection to the host lost. Reconnect to continue." };
  if (login.readFailed || login.actionFailed)
    return {
      tone: "error",
      text: upgrade
        ? `Could not confirm the upgrade.${kept}`
        : "Could not confirm the request. Refresh to check its status.",
    };
  if (notice) return { tone: "error", text: notice.text, sequence: notice.sequence };
  if (login.actionPending) return { tone: "busy", text: pendingText(requested) };
  if (!login.state) return { tone: "busy", text: "Checking sign-in..." };
  return null;
}

function stateStatus(
  login: Login,
  upgrade: boolean,
  kept: string,
  label: string,
  submitted: boolean,
): ConnectionStatus {
  const state: ProviderLoginState = login.state ?? { status: "idle" };
  switch (state.status) {
    case "starting":
      return { tone: "busy", text: upgrade ? "Starting the upgrade..." : "Starting sign-in..." };
    case "waiting":
      if (submitted) return { tone: "busy", text: "Checking your code..." };
      return {
        tone: "busy",
        text: state.inputRequired
          ? `Sign in to ${label}, then paste the code below`
          : "Enter the code on the sign-in page",
      };
    case "verifying":
      return {
        tone: "busy",
        text: upgrade ? "Switching to full sign-in..." : "Checking your sign-in...",
      };
    case "succeeded":
      if (upgrade) return { tone: "success", text: "Upgraded to full sign-in. Usage now shows." };
      if (login.shared) return installationConnectionStatus(login.synchronization, labelOf(label));
      return {
        tone: "success",
        text: state.accountLabel ? `Signed in as ${state.accountLabel}` : "Signed in",
      };
    case "failed":
      return { tone: "error", text: `${state.message}${kept}` };
    case "cancelled":
      return {
        tone: "neutral",
        text: upgrade ? `Upgrade cancelled.${kept}` : "Sign-in cancelled",
      };
    case "idle":
      if (login.shared) return installationConnectionStatus(login.synchronization, labelOf(label));
      return { tone: "neutral", text: "Not signed in" };
  }
}

function labelOf(label: string): "Claude" | "Codex" {
  return label === "Claude" ? "Claude" : "Codex";
}

function pendingText(requested: Requested | null): string {
  if (requested === "cancel") return "Cancelling...";
  if (requested === "sign-out") return "Disconnecting...";
  if (requested === "submit") return "Checking your code...";
  return "Starting sign-in...";
}

const successPalette = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const errorPalette = (theme: Theme) => ({ color: theme.colors.destructive });
const mutedPalette = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const SuccessIcon = withUnistyles(CheckCircle2);
const ErrorIcon = withUnistyles(AlertTriangle);
const Spinner = withUnistyles(LoadingSpinner);
const STATUS_ICON_SIZE = 16;
/** A status with an optional sequence, so a repeated notice is announced again. */
type PanelStatus = ConnectionStatus & { sequence?: number };
const statusLineHeight = (fontSize: number) => Math.round(fontSize * 1.4);

/** The dialog's only status indicator: a polite live region with a fixed icon slot. */
export function StatusLine({ status: next, nativeID }: { status: PanelStatus; nativeID?: string }) {
  // The live region mounts empty and receives its first message after mounting; a region that
  // mounts together with its text is not announced by most screen readers. A repeated message
  // (new sequence, same text) clears for a frame so it is announced again.
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const key = `${next.tone}\n${next.text}`;
    const value = { tone: next.tone, text: next.text };
    if (shown.current !== key) {
      shown.current = key;
      setStatus(value);
      return;
    }
    setStatus(null);
    const frame = requestAnimationFrame(() => setStatus(value));
    return () => cancelAnimationFrame(frame);
  }, [next.tone, next.text, next.sequence]);
  let icon: ReactNode = null;
  if (status?.tone === "busy") icon = <Spinner size={STATUS_ICON_SIZE} uniProps={mutedPalette} />;
  else if (status?.tone === "success")
    icon = <SuccessIcon size={STATUS_ICON_SIZE} uniProps={successPalette} />;
  else if (status?.tone === "error")
    icon = <ErrorIcon size={STATUS_ICON_SIZE} uniProps={errorPalette} />;
  return (
    // Never re-roled, and never aria-busy, which would hold back announcements while loading.
    <View
      style={styles.status}
      role="status"
      nativeID={nativeID}
      accessibilityLiveRegion="polite"
      aria-live="polite"
      // Step focus lands here when a step has no action; never in the Tab order.
      tabIndex={-1}
      // Tests and tools read the tone; the words are copy.
      {...({ dataSet: { tone: status?.tone ?? "none" } } as object)}
      testID="provider-login-status"
    >
      {/* The words carry the state; the spinner would add "Loading, progress bar". */}
      <View style={styles.statusIcon} aria-hidden importantForAccessibility="no-hide-descendants">
        {icon}
      </View>
      <Text style={[styles.statusText, status?.tone === "error" && styles.warning]}>
        {status?.text ?? ""}
      </Text>
    </View>
  );
}

/**
 * Reserves the height of the tallest step, two labelled fields, so the hint, link and code steps
 * occupy the same box.
 */
function Details({ children }: { children: ReactNode }) {
  const compact = useIsCompactFormFactor();
  return <View style={styles.details(controlHeightForLayout("md", compact))}>{children}</View>;
}

function Hint({
  login,
  flow,
  provider,
  name,
  upgradeOffered,
}: {
  login: Login;
  flow: Flow;
  provider: "codex" | "claude";
  name: string;
  upgradeOffered: boolean;
}) {
  const status = login.state?.status;
  const lines: string[] = [];
  if (flow === "connect" && !ACTIVE.has(status)) {
    if (login.shared) {
      if (!login.synchronization?.connected || login.synchronization.needsSignIn)
        lines.push(`Sign in once. Every environment in this installation uses this connection.`);
    } else if (status !== "succeeded") {
      const account = provider === "claude" ? "Claude" : "ChatGPT";
      lines.push(`Sign in to the ${account} account for ${name}.`);
    }
  }
  if (upgradeOffered && flow === "connect")
    lines.push("Upgrade to full sign-in to see usage. This account keeps its history.");
  if (lines.length === 0) return null;
  return (
    <View style={styles.hint}>
      {lines.map((line) => (
        <Text key={line} style={styles.muted}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/** The sign-in link and either a one-time code to enter, or a field for the code Claude shows. */
function Challenge({
  state,
  login,
}: {
  state: Extract<ProviderLoginState, { status: "waiting" }>;
  login: Login;
}) {
  const { onNotice } = useContext(PanelContext);
  const copyFailed = useCallback(
    () => onNotice("Could not copy. Select the text and copy it instead."),
    [onNotice],
  );
  if (!state.inputRequired)
    return (
      <View style={styles.fields} testID="provider-device-login">
        <CopyField
          label="One-time code"
          value={state.userCode}
          spellOut
          hint={`Expires at ${new Date(state.expiresAt).toLocaleTimeString()}`}
          onCopyFailed={copyFailed}
          testID="provider-login-code"
        />
        <CopyField
          label="Sign-in page"
          value={state.verificationUrl}
          onCopyFailed={copyFailed}
          testID="provider-login-url"
        />
      </View>
    );
  return (
    <View style={styles.fields} testID="claude-browser-login">
      <CopyField
        label="Sign-in link"
        value={state.verificationUrl}
        onCopyFailed={copyFailed}
        testID="provider-login-url"
      />
      <CodeEntry login={login} />
    </View>
  );
}

/**
 * The pasted code is never shown or logged. The shared code-entry flow keeps it in the editor
 * only until it is submitted.
 */
function CodeEntry({ login }: { login: Login }) {
  const { statusId, onNotice, onSubmitted, onSubmitting } = useContext(PanelContext);
  const input = useRef<EditingTextInputHandle>(null);
  const code = useRef("");
  // A single-use code: Enter twice, or Enter then Submit, must send it once.
  const sending = useRef(false);
  const [invalid, setInvalid] = useState(false);
  const { submitCode } = login;
  const attemptId = login.state && "attemptId" in login.state ? login.state.attemptId : null;
  const change = useCallback((text: string) => {
    code.current = text;
    setInvalid(false);
  }, []);
  const reject = useCallback(
    (message: string) => {
      setInvalid(true);
      onNotice(message);
      input.current?.focus();
    },
    [onNotice],
  );
  const submit = useCallback(async () => {
    if (sending.current || login.busy) return;
    const value = code.current.trim();
    if (!value) {
      reject("Paste the code from the sign-in page first.");
      return;
    }
    sending.current = true;
    onNotice(null);
    onSubmitting();
    try {
      await submitCode(value);
      code.current = "";
      input.current?.reset();
      onSubmitted(attemptId);
    } catch {
      reject("Could not send the code. Check it and try again.");
    } finally {
      sending.current = false;
    }
  }, [login.busy, reject, onNotice, onSubmitting, submitCode, onSubmitted, attemptId]);
  return (
    <Field label="Sign-in code">
      <View style={styles.codeRow}>
        {/* The step's primary target: step focus moves into the field inside. */}
        <View style={styles.codeInput} {...PRIMARY_ACTION}>
          <FormTextInput
            ref={input}
            initialValue=""
            onChangeText={change}
            onSubmitEditing={submit}
            // Enter keeps focus in the field instead of blurring it to the page.
            blurOnSubmit={false}
            // The code is a credential: masked, and kept away from password managers.
            secureTextEntry
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            importantForAutofill="no"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Sign-in code"
            // Code errors are written to the status line, so the field points at it.
            {...({ "aria-describedby": statusId, "aria-invalid": invalid || undefined } as object)}
            placeholder="Paste the code"
            testID="claude-login-code"
          />
        </View>
        <Button
          variant="default"
          onPress={submit}
          // Stays focusable without a code or while sending; pressing it explains or waits.
          disabled={login.busy || !login.connected}
          focusableWhenDisabled
          testID="claude-login-submit"
        >
          Submit code
        </Button>
      </View>
    </Field>
  );
}

function ActiveActions({
  login,
  waiting,
  onCancel,
  onNotice,
}: {
  login: Login;
  waiting: Extract<ProviderLoginState, { status: "waiting" }> | null;
  onCancel(): void;
  onNotice(notice: string | null): void;
}) {
  const url = waiting?.verificationUrl;
  const open = useCallback(async () => {
    if (!url) return;
    try {
      await openExternalUrl(url);
    } catch {
      onNotice("Could not open the browser. Copy the link instead.");
    }
  }, [url, onNotice]);
  const disabled = login.busy || !login.connected;
  return (
    <>
      <Button variant="outline" onPress={onCancel} disabled={disabled} focusableWhenDisabled>
        Cancel sign-in
      </Button>
      {waiting ? (
        <Button
          // The pasted-code step's primary action is Submit code.
          variant={waiting.inputRequired ? "outline" : "default"}
          onPress={open}
          accessibilityHint="Opens in your browser"
          testID="provider-login-open"
          {...(waiting.inputRequired ? {} : PRIMARY_ACTION)}
        >
          Open sign-in page
        </Button>
      ) : null}
    </>
  );
}

function startLabel(login: Login, label: string): string {
  const status = login.state?.status;
  if (status === "failed" || status === "cancelled") return "Try again";
  if (status === "succeeded" || (login.shared && login.synchronization?.connected))
    return `Reconnect ${label}`;
  return login.shared ? `Connect ${label}` : "Sign in";
}

function IdleActions({
  login,
  flow,
  label,
  upgrade,
  upgradeEngaged,
  upgradeStopped,
  onStartConnect,
  onStartUpgrade,
  onSignOut,
  focusSignIn,
}: {
  login: Login;
  flow: Flow;
  label: string;
  upgrade: Login | null;
  upgradeEngaged: boolean;
  upgradeStopped: boolean;
  onStartConnect(): void;
  onStartUpgrade(): void;
  onSignOut(): void;
  focusSignIn?: boolean;
}) {
  // A finished upgrade has nothing left to do here.
  if (flow === "upgrade" && upgradeEngaged) return null;
  const unconfirmed = login.readFailed || login.actionFailed;
  const disabled = login.busy || !login.connected;
  const disconnect = login.shared && login.synchronization?.connected;
  const showStart = login.shared || login.state?.status !== "succeeded";
  return (
    <>
      {disconnect ? (
        <ActionFooterLeading>
          <Button variant="outline" onPress={onSignOut} disabled={disabled} focusableWhenDisabled>
            Disconnect
          </Button>
        </ActionFooterLeading>
      ) : null}
      {unconfirmed && flow === "connect" ? (
        <Button
          variant="outline"
          onPress={login.refresh}
          disabled={login.refreshing}
          focusableWhenDisabled
        >
          Refresh
        </Button>
      ) : null}
      {upgrade ? (
        <Button
          variant="outline"
          onPress={onStartUpgrade}
          disabled={upgrade.busy || !upgrade.connected}
          focusableWhenDisabled
        >
          {upgradeStopped ? "Try the upgrade again" : "Upgrade to full sign-in"}
        </Button>
      ) : null}
      {showStart ? (
        <StartButton
          onPress={onStartConnect}
          disabled={disabled || !login.state || login.readFailed}
          focus={focusSignIn === true}
        >
          {startLabel(login, label)}
        </StartButton>
      ) : null}
    </>
  );
}

/** The primary sign-in button; optionally takes focus once, the first time it is enabled. */
function StartButton({
  onPress,
  disabled,
  focus,
  children,
}: {
  onPress(): void;
  disabled: boolean;
  focus: boolean;
  children: string;
}) {
  const ref = useRef<View>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focus || disabled || focused.current || !ref.current) return;
    focused.current = true;
    if (isWeb) {
      (ref.current as unknown as { focus?: () => void }).focus?.();
      return;
    }
    const tag = findNodeHandle(ref.current);
    if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
  }, [focus, disabled]);
  return (
    <Button
      ref={ref}
      variant="default"
      onPress={onPress}
      disabled={disabled}
      focusableWhenDisabled
      {...PRIMARY_ACTION}
    >
      {children}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  warning: { color: theme.colors.destructive },
  // Top-aligned so the first line sits on the body's top rail; two lines are reserved, so a
  // wrapped message does not push the dialog down.
  status: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    minHeight: 2 * statusLineHeight(theme.fontSize.base),
  },
  // As tall as one text line, so the icon centers on the first line.
  statusIcon: {
    width: STATUS_ICON_SIZE,
    height: statusLineHeight(theme.fontSize.base),
    alignItems: "center",
    justifyContent: "center",
  },
  statusText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: statusLineHeight(theme.fontSize.base),
    fontWeight: theme.fontWeight.medium,
  },
  // Each field: a label line, its gap and the control; the device step adds a hint line.
  details: (control: number) => ({
    minHeight: 2 * (control + theme.spacing[7] + theme.spacing[2]) + theme.spacing[4],
  }),
  hint: { gap: theme.spacing[2] },
  fields: { gap: theme.spacing[4] },
  codeRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  codeInput: { flex: 1, minWidth: 0 },
  actions: { paddingTop: 0 },
}));
