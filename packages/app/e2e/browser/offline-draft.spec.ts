import { expect, test } from "../support/fixtures";
import { chooseMockModelProfile } from "../support/helpers/model-profile";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { createAgentTabFromMenu } from "../support/helpers/workspace-tabs";
import { fillComposerDraft } from "../support/helpers/composer";

async function restoreHostConnection(gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>) {
  gate.holdNextServerMessage("status");
  gate.restore();
  await gate.waitForHeldServerMessage("status");
  gate.releaseHeldServerMessage("status");
}

test("an unconfigured offline draft requires reconnection before profile selection", async ({
  page,
  withWorkspace,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await withWorkspace();
  await workspace.navigateTo();
  const createsBefore = gate.getClientRequestCount("create_agent_request");
  const sendsBefore = gate.getClientRequestCount("send_agent_message_request");
  await gate.drop();
  await gate.waitForBlockedConnection();
  await createAgentTabFromMenu(page);
  await fillComposerDraft(page, "hello");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Reconnect to this environment to select a profile" }),
  ).toHaveText("Reconnect to this environment to select a profile");
  await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue("hello");
  const guidance = page.getByLabel("Select a configuration before submitting.", { exact: true });
  await guidance.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Select a configuration before submitting.",
  );
  await guidance.focus();
  await guidance.press("Enter");
  await guidance.press("Space");
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue("hello");
  expect(gate.getClientRequestCount("create_agent_request")).toBe(createsBefore);
  expect(gate.getClientRequestCount("send_agent_message_request")).toBe(sendsBefore);
  await restoreHostConnection(gate);
  await expect(page.getByTestId("preset-account-mock")).toBeVisible();
  await expect(
    page.getByText("Reconnect to this environment to select a profile", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue("hello");
  // Models are selected through profiles in the retained inline chooser.
  await chooseMockModelProfile(page, "Ten second stream");
  await expect(
    page.getByTestId("preset-row-shared-profile/mock/e2e-mock-ten-second-stream"),
  ).toContainText("Ten second stream");
  expect(gate.getClientRequestCount("create_agent_request")).toBe(createsBefore);
  expect(gate.getClientRequestCount("send_agent_message_request")).toBe(sendsBefore);
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue("hello");
});
