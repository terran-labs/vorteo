import { expect, type Page } from "@playwright/test";
import { buildCreateAgentPreferences, buildSeededHost } from "./daemon-registry";
import { getServerId } from "./server-id";
import { openSettings } from "./app";
import { expectAppRoute } from "./route-assertions";
import { buildSettingsRoute } from "@/utils/host-routes";
import { getSection, resolveSettingsTarget } from "@/settings-catalog/catalog";

const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";
const REGISTRY_KEY = "@paseo:daemon-registry";

interface SavedSettingsHostInput {
  serverId: string;
  label: string;
  endpoint: string;
}

/** Old settings page names that specs open; the catalog maps each to its new place. */
const OLD_SETTINGS_PAGES = [
  "general",
  "interface",
  // Retired section addresses: Privacy now opens in Interface.
  "privacy",
  "system",
  "chat",
  "appearance",
  "sidebar",
  "editor",
  "terminal",
  "browser",
  "shortcuts",
  "integrations",
  "permissions",
  "diagnostics",
  "files",
  "about",
] as const;

export type SettingsSection = (typeof OLD_SETTINGS_PAGES)[number];

type HostSection =
  | "projects"
  | "connections"
  | "pair-device"
  | "agents"
  | "metadata"
  | "voice"
  | "workspaces"
  | "providers"
  | "usage"
  | "terminals"
  | "plugins"
  | "host";

/**
 * Opens a settings location by its old page name. Settings is one scrolling
 * page now; the catalog maps each old name to its section and pane.
 */
export async function openSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();
  await revealSettingsLocation(page, section);
}

/**
 * Panes whose controls sit in a collapsed Advanced group, keyed to that group's test ID. Some
 * groups render in a sibling pane, so the helper opens the group itself rather than the pane.
 */
const ADVANCED_GROUPS: Record<string, string> = {
  "general.hosts": "settings-system-advanced",
  "maintenance.installation": "settings-system-advanced",
  "agents.metadata": "settings-agents-advanced",
  "agents.permissions": "settings-interface-advanced",
  "agents.browserData": "settings-interface-advanced",
};

/** An open environment Edit dialog, desktop card or compact sheet alike. */
function environmentDialogs(page: Page) {
  return page
    .getByRole("dialog")
    .filter({ has: page.locator('[data-testid^="settings-environment-"]') });
}

/** Closes an environment's settings dialog, which covers the page and its sidebar. */
export async function closeSettingsDialog(page: Page): Promise<void> {
  const dialog = environmentDialogs(page).filter({ visible: true });
  if (!(await dialog.count())) return;
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

/** Scrolls the settings page to the pane that an old settings page name now opens. */
export async function revealSettingsLocation(page: Page, slug: string): Promise<void> {
  const target = resolveSettingsTarget(slug);
  await closeSettingsDialog(page);
  if (
    (page.viewportSize()?.width ?? 1280) < 768 &&
    !(await page.getByTestId("settings-sidebar").isVisible())
  ) {
    await page.getByRole("button", { name: "Back", exact: true }).first().click();
  }
  // A drill-in can leave an earlier settings screen mounted but hidden, and a section can also
  // appear in the page body, so use the visible sidebar's entry and the visible anchor.
  const sidebar = page.getByTestId("settings-sidebar").filter({ visible: true }).first();
  const scope = (await sidebar.isVisible()) ? sidebar : page;
  await scope
    .getByTestId(`settings-section-${target.section}`)
    .filter({ visible: true })
    .first()
    .click();
  const advancedGroup = target.pane ? ADVANCED_GROUPS[target.pane] : undefined;
  if (advancedGroup) {
    // A sidebar jump lands on the section; open the right Advanced group as a reader would.
    const toggle = page.getByTestId(`${advancedGroup}-toggle`).filter({ visible: true }).first();
    await toggle.scrollIntoViewIfNeeded();
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    return;
  }
  const anchor = page
    .getByTestId(
      target.pane ? `settings-pane-${target.pane}` : `settings-page-section-${target.section}`,
    )
    .filter({ visible: true })
    .first();
  await expect(anchor).toBeVisible();
  if (target.pane) {
    // A fresh section jump stays pinned until the reader scrolls. Release it
    // with a real gesture before scrolling farther to the requested pane.
    const scroll = page.getByTestId("settings-scroll-page").filter({ visible: true }).first();
    await scroll.hover();
    await page.mouse.wheel(0, 1);
  }
  await anchor.scrollIntoViewIfNeeded();
}

/**
 * Chooses an app language from Interface > Language. The pane's trigger is named after the
 * current choice, and System is also a Settings section, so scope the trigger to the pane.
 */
export async function chooseSettingsLanguage(
  page: Page,
  option: string,
  current: string | RegExp = /^System(?:\s|$)/,
): Promise<void> {
  await revealSettingsLocation(page, "appearance.language");
  await page
    .getByTestId("settings-pane-appearance.language")
    .filter({ visible: true })
    .first()
    .getByRole(
      "button",
      typeof current === "string" ? { name: current, exact: true } : { name: current },
    )
    .click();
  await page.getByRole("menuitem", { name: option, exact: true }).click();
}

export async function revealSettingsSidebarSection(
  page: Page,
  section: SettingsSection,
): Promise<number> {
  const target = resolveSettingsTarget(section);
  const sidebar = page.getByTestId("settings-sidebar").filter({ visible: true }).first();
  await sidebar.getByTestId(`settings-section-${target.section}`).scrollIntoViewIfNeeded();
  const offset = await page
    .getByTestId("settings-sidebar-scroll-body")
    .evaluate((node) => node.scrollTop);
  expect(offset).toBeGreaterThan(0);
  return offset;
}

export async function expectSettingsSidebarScrollSettled(
  page: Page,
  offset: number,
): Promise<void> {
  // RN Web emits its final scroll callback 100 ms after scrolling stops.
  await page.waitForTimeout(200);
  await expectSettingsSidebarScrollOffset(page, offset);
}

export async function selectSettingsHostSectionsRapidly(page: Page): Promise<void> {
  for (let selection = 0; selection < 5; selection += 1) {
    await page.getByTestId("settings-section-providers").dispatchEvent("click");
    await page.getByTestId("settings-section-agents").dispatchEvent("click");
  }
  await expect(page.getByTestId("settings-page-section-agents")).toBeVisible();
}

export async function scrollSettingsSidebarUp(page: Page, pixels: number): Promise<void> {
  await page.getByTestId("settings-sidebar-scroll-body").hover();
  await page.mouse.wheel(0, -pixels);
}

export async function changeSettingsInterfaceFontSize(page: Page, size: number): Promise<void> {
  const input = page.getByRole("textbox", { name: "Interface font size" });
  await input.fill(String(size));
  await input.press("Tab");
  await expect(input).toHaveValue(String(size));
}

export async function scrollSettingsSidebarToEnd(page: Page): Promise<number> {
  const scrollBody = page.locator('[data-testid="settings-sidebar-scroll-body"]:visible');
  await scrollBody.hover();
  await page.mouse.wheel(0, 2000);
  await expect
    .poll(() =>
      scrollBody.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
    )
    .toBe(0);
  const offset = await scrollBody.evaluate((node) => node.scrollTop);
  expect(offset).toBeGreaterThan(0);
  return offset;
}

export async function expectSettingsSidebarScrollOffset(page: Page, offset: number): Promise<void> {
  const scrollBody = page.locator('[data-testid="settings-sidebar-scroll-body"]:visible');
  await expect.poll(() => scrollBody.evaluate((node) => node.scrollTop)).toBe(offset);
}

export async function scrollSettingsDetailDown(page: Page): Promise<number> {
  const scrollBody = page.getByTestId("settings-scroll-page").filter({ visible: true }).first();
  await expect
    .poll(() => scrollBody.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(0);
  const before = await scrollBody.evaluate((node) => ({
    top: node.scrollTop,
    maximum: node.scrollHeight - node.clientHeight,
  }));
  const target = Math.min(before.top + 1000, before.maximum);
  expect(target).toBeGreaterThan(before.top);
  await scrollBody.hover();
  await page.mouse.wheel(0, 1000);
  // Continuous Settings already has a positive offset before the wheel event arrives.
  await expect.poll(() => scrollBody.evaluate((node) => node.scrollTop)).toBe(target);
  return target;
}

export async function expectSettingsDetailScrollOffset(page: Page, offset: number): Promise<void> {
  const scrollBody = page.getByTestId("settings-scroll-page").filter({ visible: true }).first();
  await expect.poll(() => scrollBody.evaluate((node) => node.scrollTop)).toBe(offset);
}

export async function openSettingsHost(page: Page, serverId: string): Promise<void> {
  await openSettingsHostSection(page, serverId, "connections");
  await expect(
    settingsHostConnections(page, serverId).getByTestId("host-page-connections-card"),
  ).toBeVisible();
}

/** One host's connections, in the Connections group under System (not in its Edit dialog). */
export function settingsHostConnections(page: Page, serverId: string) {
  return page
    .getByTestId(`settings-environment-${serverId}`)
    .filter({ has: page.getByTestId("host-page-connections-card") })
    .first();
}

export async function openSettingsHostSection(
  page: Page,
  serverId: string,
  section: HostSection,
): Promise<void> {
  await revealSettingsLocation(page, section === "host" ? "environments" : section);
  await expect(page.getByTestId("settings-host-picker")).toHaveCount(0);
  // Connections sit on the page itself; only the host overview lives in the Edit dialog.
  if (section === "host") await openSettingsEnvironment(page, serverId);
}

/**
 * Environments in System lists one row per host. Edit opens that host's settings in a dialog,
 * which stays open for the caller; navigation helpers close it first.
 */
export async function openSettingsEnvironment(page: Page, serverId: string): Promise<void> {
  // Connections also marks its per-host cards with this id, so look inside the dialog only.
  const details = settingsEnvironmentDetails(page, serverId);
  if (await details.isVisible()) return;
  await closeSettingsDialog(page);
  await page.getByTestId(`settings-environment-row-${serverId}-open`).click();
  await expect(details).toBeVisible();
}

/**
 * Opens an environment's dialog and its collapsed exceptions group, where per-environment
 * availability switches for shared resources live.
 */
export async function openSettingsEnvironmentExceptions(page: Page, serverId: string) {
  await openSettingsEnvironment(page, serverId);
  const toggle = page.getByTestId(`settings-environment-exceptions-${serverId}-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return settingsEnvironmentDetails(page, serverId);
}

/** One environment's full settings, inside its Edit dialog. */
export function settingsEnvironmentDetails(page: Page, serverId: string) {
  // The compact sheet puts the row's test ID on its header, so scope by the dialog role.
  return page.getByRole("dialog").getByTestId(`settings-environment-${serverId}`).first();
}

/** A section or pane title is visible in the settings page, or a drill-in page's title. */
export async function expectSettingsHeader(page: Page, title: string): Promise<void> {
  const scrollPage = page.getByTestId("settings-scroll-page");
  if (await scrollPage.isVisible()) {
    await expect(scrollPage.getByText(title, { exact: true }).first()).toBeVisible();
    return;
  }
  await expect(page.getByTestId("page-title")).toHaveText(title);
}

export async function openAddHostFlow(page: Page): Promise<void> {
  if (!(await page.getByTestId("settings-add-host").isVisible())) {
    await closeSettingsDialog(page);
    // Connections lives in System now.
    const section = page.getByTestId("settings-section-system");
    if (!(await section.isVisible())) await goBackInSettings(page);
    await revealSettingsLocation(page, "connections");
  }
  await page.getByTestId("settings-add-host").click();
  // Phones present the same controls in a bottom sheet rather than a dialog.
  await expect(page.getByRole("button", { name: "Direct connection", exact: true })).toBeVisible();
}

export async function selectHostConnectionType(
  page: Page,
  type: "direct" | "relay",
): Promise<void> {
  const label = type === "direct" ? "Direct connection" : "Paste pairing link";
  await page.getByRole("button", { name: label }).click();
}

export async function addDirectHostFromSettings(
  page: Page,
  input: { host: string; port: number; password?: string },
): Promise<void> {
  await openAddHostFlow(page);
  await selectHostConnectionType(page, "direct");
  await page.getByTestId("direct-host-input").fill(input.host);
  await page.getByTestId("direct-port-input").fill(String(input.port));
  if (input.password) {
    await page.getByTestId("direct-password-input").fill(input.password);
  }
  await page.getByTestId("direct-host-submit").click();
  await expect(page.getByTestId("direct-host-submit")).toBeHidden({ timeout: 30_000 });
}

export async function toggleHostAdvanced(page: Page): Promise<void> {
  await page.getByTestId("direct-host-advanced-toggle").click();
}

export async function openCompactSettings(page: Page, expectedStartRoute: string): Promise<void> {
  await expectAppRoute(page, expectedStartRoute, { timeout: 15_000 });
  await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
  const settingsButton = page.locator('[data-testid="sidebar-settings"]:visible').first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expectAppRoute(page, buildSettingsRoute());
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
}

export async function seedSavedSettingsHosts(
  page: Page,
  hosts: SavedSettingsHostInput[],
): Promise<void> {
  // This visit only establishes storage and the fixture nonce; callers reload the real app next.
  await page.goto("/", { waitUntil: "commit" });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), SEED_NONCE_KEY);
  const nowIso = new Date().toISOString();
  const registry = hosts.map((host) =>
    buildSeededHost({
      serverId: host.serverId,
      label: host.label,
      endpoint: host.endpoint,
      nowIso,
    }),
  );
  const firstHost = registry[0];
  if (!firstHost) {
    throw new Error("Expected at least one settings host fixture.");
  }
  const preferences = buildCreateAgentPreferences();

  await page.evaluate(
    ({ keys, storedRegistry, storedPreferences }) => {
      const nonce = localStorage.getItem(keys.seedNonce);
      if (!nonce) {
        throw new Error("Expected e2e seed nonce before overriding settings host registry.");
      }

      localStorage.setItem(keys.registry, JSON.stringify(storedRegistry));
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(storedPreferences));
      localStorage.setItem(keys.disableDefaultSeedOnce, nonce);
    },
    {
      keys: {
        disableDefaultSeedOnce: DISABLE_DEFAULT_SEED_ONCE_KEY,
        registry: REGISTRY_KEY,
        seedNonce: SEED_NONCE_KEY,
      },
      storedRegistry: registry,
      storedPreferences: preferences,
    },
  );
}

export async function expectCompactSettingsList(page: Page): Promise<void> {
  await expectAppRoute(page, buildSettingsRoute());
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await expect(page.getByText("Theme", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play test" })).toHaveCount(0);
  await expect(page.getByTestId("host-page-connections-card")).toHaveCount(0);
}

export async function expectSettingsSidebarVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
}

export async function expectSettingsSidebarHidden(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="settings-sidebar"]:visible')).toHaveCount(0);
}

export async function expectSettingsSidebarSections(
  page: Page,
  sections: SettingsSection[],
): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  for (const section of sections) {
    const label = getSection(resolveSettingsTarget(section).section).label;
    await expect(sidebar.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
}

export async function goBackInSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back", exact: true }).click();
}

export async function closeCompactSettings(page: Page): Promise<void> {
  await goBackInSettings(page);
  await expect(page).not.toHaveURL(/\/settings(\/|$)/);
}

/**
 * Opens the collapsed Advanced group in a host's Edit dialog, where Remove host waits under its
 * Danger zone heading. The dialog must already be open.
 */
export async function openHostAdvanced(page: Page, serverId: string): Promise<void> {
  const toggle = page
    .getByTestId(`host-page-advanced-${serverId}-toggle`)
    .filter({ visible: true })
    .first();
  await toggle.scrollIntoViewIfNeeded();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

export async function removeCurrentHostFromSettings(
  page: Page,
  serverId = getServerId(),
): Promise<void> {
  await openHostAdvanced(page, serverId);
  await page.getByTestId("host-page-remove-host-button").click();
  await expect(page.getByTestId("remove-host-confirm-modal")).toBeVisible();
  await page.getByTestId("remove-host-confirm").click();
  await expectAppRoute(page, buildSettingsRoute());
}

export async function expectSettingsBackButton(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
}

export async function clickSettingsBackToWorkspace(page: Page): Promise<void> {
  // Adding a host opens its Edit dialog, whose backdrop covers the sidebar's Back button.
  await closeSettingsDialog(page);
  const desktopBack = page.getByTestId("settings-back-to-workspace");
  if (await desktopBack.isVisible()) {
    await desktopBack.click();
    return;
  }
  await goBackInSettings(page);
  if (new URL(page.url()).pathname.startsWith("/settings")) await goBackInSettings(page);
}

/**
 * Connections lives in System. Its own address is kept when opened directly; compact
 * navigation and the scroll position can show the section's address.
 */
export async function expectHostSettingsUrl(page: Page, _serverId: string): Promise<void> {
  await expect(page).toHaveURL(/\/settings\/(connections|environments|system)$/);
}

export async function verifyLegacyHostSettingsRedirect(page: Page): Promise<void> {
  const serverId = getServerId();
  await page.goto(`/h/${encodeURIComponent(serverId)}/settings`);
  await expectHostSettingsUrl(page, serverId);
}

export async function openCompactSettingsHost(page: Page): Promise<void> {
  const serverId = getServerId();
  await openSettingsHost(page, serverId);
  await expectHostSettingsUrl(page, serverId);
}

export async function expectAddHostMethodOptions(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Direct connection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste pairing link" })).toHaveCount(0);
}

export async function fillDirectHostUri(page: Page, uri: string): Promise<void> {
  await page.getByTestId("direct-host-uri-input").fill(uri);
}

export async function expectDirectHostFormValues(
  page: Page,
  fields: { host: string; port: string; password: string },
): Promise<void> {
  await expect(page.getByTestId("direct-host-input")).toHaveValue(fields.host);
  await expect(page.getByTestId("direct-port-input")).toHaveValue(fields.port);
  await expect(page.getByTestId("direct-password-input")).toHaveValue(fields.password);
}

export async function expectDirectHostSslEnabled(page: Page): Promise<void> {
  await expect(page.getByRole("checkbox", { name: "Use SSL", exact: true })).toBeChecked();
  await expect(page.getByTestId("direct-ssl-toggle-checked")).toBeVisible();
}

export async function fillDirectHostAddress(page: Page, host: string, port: string): Promise<void> {
  await page.getByRole("textbox", { name: "Host", exact: true }).fill(host);
  await page.getByRole("textbox", { name: "Port", exact: true }).fill(port);
}

export async function toggleDirectHostSsl(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: "Use SSL", exact: true }).click();
}

export async function expectDirectHostSslDisabled(page: Page): Promise<void> {
  await expect(page.getByRole("checkbox", { name: "Use SSL", exact: true })).not.toBeChecked();
  await expect(page.getByTestId("direct-ssl-toggle-checked")).toHaveCount(0);
}

export async function expectDirectHostUriValue(page: Page, uri: string): Promise<void> {
  await expect(page.getByTestId("direct-host-uri-input")).toHaveValue(uri);
}

export async function expectDirectHostUriHidden(page: Page): Promise<void> {
  await expect(page.getByTestId("direct-host-uri-input")).toHaveCount(0);
}

export async function expectDiagnosticsContent(page: Page): Promise<void> {
  await expect(
    page.getByTestId("app-diagnostic-row").getByRole("button", { name: "Run", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Play test" })).toBeVisible();
}

export async function expectAboutContent(page: Page): Promise<void> {
  await expect(page.getByText("App version", { exact: true }).first()).toBeVisible();
}

export async function expectGeneralContent(page: Page): Promise<void> {
  // What needs attention moved from General to the top of System.
  await expect(page.getByTestId("settings-pane-system.health")).toHaveCount(1);
  await expect(page.getByTestId("settings-pane-chat.sending")).toHaveCount(1);
  await expect(page.getByTestId("settings-pane-general.sending")).toHaveCount(0);
}

export async function expectAppearanceContent(page: Page): Promise<void> {
  await expect(page.getByText("Highlight theme", { exact: true }).first()).toBeVisible();
}

export async function expectHostLabelDisplayed(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-label-edit-button")).toBeVisible();
  await expect(page.getByTestId("host-page-rename-modal-input")).toHaveCount(0);
}

export async function clickEditHostLabel(page: Page): Promise<void> {
  await page.getByTestId("host-page-label-edit-button").click();
}

export async function expectHostLabelEditMode(page: Page, expectedLabel: string): Promise<void> {
  await expect(page.getByTestId("host-page-rename-modal-input")).toBeVisible();
  await expect(page.getByTestId("host-page-rename-modal-input")).toHaveValue(expectedLabel);
  await expect(page.getByTestId("host-page-rename-modal-submit")).toBeVisible();
}

export async function expectHostConnectionsCard(page: Page, port: string): Promise<void> {
  const card = page.getByTestId("host-page-connections-card");
  await expect(card).toBeVisible();
  // "Connections" can appear more than once on this page (pane heading and
  // card heading). Match the first to keep the heading assertion without
  // tripping Playwright strict mode.
  await expect(page.getByText("Connections", { exact: true }).first()).toBeVisible();
  await expect(
    card.getByText(new RegExp(`TCP \\((localhost|127\\.0\\.0\\.1):${port}\\)`)),
  ).toBeVisible();
}

export async function expectHostInjectMcpCard(page: Page): Promise<void> {
  const card = page.getByTestId("host-page-inject-mcp-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("switch", { name: "Inject Vorteo tools" })).toBeVisible();
}

/**
 * Selects a host, then opens the System page's "When the Host restarts" section, which holds
 * the resume-after-restart and idle-release switches for the selected host.
 */
export async function openHostRestartBehavior(page: Page, serverId: string): Promise<void> {
  await selectSettingsHost(page, serverId);
  await revealSettingsLocation(page, "system.overview");
  await expect(page.getByTestId("system-restart-behavior")).toBeVisible();
}

function idleAgentReleaseSwitch(page: Page) {
  return page
    .getByTestId("host-page-idle-runtime-cleanup-card")
    .getByRole("switch", { name: "Release idle agents" });
}

export async function expectIdleAgentRelease(page: Page, enabled: boolean): Promise<void> {
  const toggle = idleAgentReleaseSwitch(page);
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
}

export async function setIdleAgentRelease(page: Page, enabled: boolean): Promise<void> {
  const toggle = idleAgentReleaseSwitch(page);
  await expect(toggle).toHaveAttribute("aria-checked", String(!enabled));
  await toggle.click();
  await expectIdleAgentRelease(page, enabled);
}

export async function openHostSection(
  page: Page,
  serverId: string,
  section: HostSection,
): Promise<void> {
  if (section === "host") {
    // Navigate inside the app: a full page load reseeds the host registry and drops added hosts.
    if (!(await page.getByTestId("settings-scroll-page").isVisible())) {
      await openSettings(page);
    }
    await openSettingsHostSection(page, serverId, "host");
    // The environment dialog renders only that host, so its identity badges are unique.
    await expect(page.getByTestId("host-page-identity")).toBeVisible();
    return;
  }
  await openSettingsHostSection(page, serverId, section);
}

export async function expectHostActionCards(page: Page, serverId: string): Promise<void> {
  // Restart + remove cards live on the Host section; providers moved to its
  // own Providers section (asserted via expectHostProvidersCard).
  await openSettingsHostSection(page, serverId, "host");
  await expect(page.getByTestId("host-page-restart-card")).toBeVisible();
  await expect(page.getByTestId("host-page-restart-button")).toBeVisible();
  await expect(page.getByTestId("host-page-remove-host-card")).toBeVisible();
  await expect(page.getByTestId("host-page-remove-host-button")).toBeVisible();
}

export async function expectHostProvidersCard(page: Page, serverId: string): Promise<void> {
  await openSettingsHostSection(page, serverId, "providers");
  await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
}

export async function serveJson(page: Page, url: string, body: unknown): Promise<void> {
  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

export async function openAddProviderArea(page: Page): Promise<void> {
  await page.getByTestId("host-page-add-provider-card").scrollIntoViewIfNeeded();
  await expect(page.getByRole("textbox", { name: "Search providers" })).toBeVisible();
}

export async function findAcpCatalogProvider(page: Page, providerName: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search providers" }).fill(providerName);
  await expect(page.getByText(providerName, { exact: true })).toBeVisible();
}

export async function installAcpCatalogProvider(page: Page, providerName: string): Promise<void> {
  await findAcpCatalogProvider(page, providerName);
  await page.getByRole("button", { name: `Add ${providerName}`, exact: true }).click();
}

export async function expectProviderInstalledInSettings(
  page: Page,
  providerName: string,
): Promise<void> {
  await expect(
    page.getByRole("button", { name: `${providerName} provider details`, exact: true }),
  ).toBeVisible();
}

export async function expectHostNoDaemonLifecycleRow(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-daemon-lifecycle-card")).toHaveCount(0);
}

export async function expectRetiredSidebarSectionsAbsent(page: Page): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();

  // One entry per section; old pages are panes inside them.
  for (const id of ["interface", "general", "providers", "agents", "projects", "system"]) {
    await expect(sidebar.getByTestId(`settings-section-${id}`)).toBeVisible();
  }
  await expect(sidebar.getByRole("button", { name: "Daemon", exact: true })).toHaveCount(0);
  for (const retired of [
    // Privacy folded into Interface and Environments into System.
    "privacy",
    "environments",
    "connections",
    "accounts",
    "maintenance",
    "usage",
    "diagnostics",
    "about",
  ]) {
    await expect(sidebar.getByTestId(`settings-section-${retired}`)).toHaveCount(0);
  }

  // No host selection changes the meaning of these settings.
  await expect(sidebar.locator('[data-testid^="settings-host-entry-"]')).toHaveCount(0);
}

export async function expectHostPageVisible(page: Page, _serverId: string): Promise<void> {
  await expect(page.getByTestId("host-page-connections-card")).toBeVisible();
}

export async function expectLocalHostEntryFirst(page: Page, _serverId: string): Promise<void> {
  await expect(page.getByTestId("settings-sidebar")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("settings-host-picker")).toHaveCount(0);
  await expect(page.getByTestId("settings-section-system")).toBeVisible();
}

export async function expectHostRejectedWithReAddGuidance(
  page: Page,
  reason: string,
): Promise<void> {
  // Environments and Connections both show the host's connection error; check the first.
  const error = page.getByTestId("host-connection-error").first();
  await expect(error).toContainText(reason);
  await expect(error).toContainText(
    "Remove this host and add it again with the password this daemon asks for.",
  );
}

export async function expectNoHostPasswordControls(page: Page): Promise<void> {
  await expect(page.getByText("Password", { exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /password/i })).toHaveCount(0);
}

export async function removeHostFromHostPage(page: Page, serverId: string): Promise<void> {
  await openHostAdvanced(page, serverId);
  await page.getByTestId("host-page-remove-host-button").click();
  await page.getByTestId("remove-host-confirm").click();
  await expect(page).not.toHaveURL(new RegExp(`/settings/hosts/${serverId}`));
}

export async function expectHostOnlineWithoutError(page: Page): Promise<void> {
  await expect(page.getByTestId("host-page-identity")).toContainText("Online");
  await expect(page.getByTestId("host-connection-error")).toHaveCount(0);
}

function restartRecoverySwitch(page: Page) {
  return page.getByRole("switch", { name: "Resume agents after restart", exact: true });
}

function restartRecoveryEditButton(page: Page) {
  return page.getByRole("button", { name: "Edit prompt", exact: true });
}

export async function setRestartRecoveryEnabled(page: Page, enabled: boolean) {
  const toggle = restartRecoverySwitch(page);
  await toggle.click();
  await expectRestartRecoveryEnabled(page, enabled);
}

// The prompt is only editable while restart recovery is on.
export async function expectRestartRecoveryEnabled(page: Page, enabled: boolean) {
  await expect(restartRecoverySwitch(page)).toBeChecked({ checked: enabled });
  await expect(restartRecoveryEditButton(page)).toBeEnabled({ enabled });
}

export async function editRestartRecoveryPrompt(page: Page, prompt: string) {
  await restartRecoveryEditButton(page).click();
  const sheet = page.getByTestId("host-page-restart-recovery-sheet");
  await sheet.getByRole("textbox", { name: "Resume prompt", exact: true }).fill(prompt);
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

export async function expectRestartRecoveryPrompt(page: Page, prompt: string) {
  await restartRecoveryEditButton(page).click();
  const sheet = page.getByTestId("host-page-restart-recovery-sheet");
  await expect(sheet.getByRole("textbox", { name: "Resume prompt", exact: true })).toHaveValue(
    prompt,
  );
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

/**
 * Chooses the host System shows, without reintroducing the retired global host picker: opening
 * an environment's dialog selects it, and the choice outlives the dialog.
 */
export async function selectSettingsHost(page: Page, serverId: string): Promise<void> {
  await revealSettingsLocation(page, "environments");
  await openSettingsEnvironment(page, serverId);
  await closeSettingsDialog(page);
}
