import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "./tooltip";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

const triggerStyle = { position: "absolute", top: 180, left: 220 } as const;

function Harness({ open }: { open?: boolean }) {
  return (
    <Tooltip open={open} enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable testID="tooltip-trigger" style={triggerStyle}>
          <Text>Details</Text>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>
        <TooltipText label="Details" description="Conversation information" />
      </TooltipContent>
    </Tooltip>
  );
}

describe("Tooltip portal cleanup", () => {
  let root: Root;
  let container: HTMLDivElement;
  let interruptedAnimations: HTMLStyleElement;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // Suppress animationstart and animationend, as when an animation is removed
    // before it starts. Keep the real Reanimated surface and its DOM lifecycle.
    interruptedAnimations = document.createElement("style");
    interruptedAnimations.textContent = '[role="tooltip"] { animation: none !important; }';
    document.head.append(interruptedAnimations);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
    interruptedAnimations.remove();
    vi.unstubAllGlobals();
  });

  async function expectVisible() {
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent)
      .toBe("DetailsConversation information");
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.getBoundingClientRect().x)
      .toBeGreaterThanOrEqual(0);
  }

  async function expectRemoved() {
    await nextFrame();
    await expect.poll(() => document.querySelectorAll('[role="tooltip"]').length).toBe(0);
  }

  it("removes the entire tooltip when closing before a web animation can start", async () => {
    flushSync(() => root.render(<Harness open />));
    await expectVisible();
    flushSync(() => root.render(<Harness open={false} />));
    await expectRemoved();
  });

  it("stays open when an unrelated region scrolls and closes when its own page scrolls", async () => {
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    flushSync(() => root.render(<Harness />));
    await userEvent.hover(document.querySelector('[data-testid="tooltip-trigger"]')!);
    await expectVisible();
    elsewhere.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextFrame();
    expect(document.querySelectorAll('[role="tooltip"]').length).toBe(1);
    document.dispatchEvent(new Event("scroll"));
    await expectRemoved();
  });

  it("removes the tooltip when its trigger unmounts during navigation", async () => {
    flushSync(() => root.render(<Harness open />));
    await expectVisible();
    flushSync(() => root.render(null));
    await expectRemoved();
  });

  it("does not accumulate floating shells across repeated open and close cycles", async () => {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      flushSync(() => root.render(<Harness open />));
      await expectVisible();
      expect(document.querySelectorAll('[role="tooltip"]').length).toBe(1);
      flushSync(() => root.render(<Harness open={false} />));
      await expectRemoved();
    }
  });

  it("preserves hover, Escape dismissal and keyboard focus without animation copies", async () => {
    interruptedAnimations.remove();
    flushSync(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLElement>('[data-testid="tooltip-trigger"]');
    if (!trigger) throw new Error("Tooltip trigger did not render");
    await userEvent.hover(trigger);
    await expectVisible();
    await userEvent.unhover(trigger);
    await expectRemoved();
    await userEvent.keyboard("{Tab}");
    await expectVisible();
    expect(document.activeElement).toBe(trigger);
    await userEvent.keyboard("{Escape}");
    await expectRemoved();
    expect(document.activeElement).toBe(trigger);
  });
  it("keeps a disabled button inert while its wrapper exposes hover and keyboard guidance", async () => {
    const press = vi.fn();
    const longPress = vi.fn();
    flushSync(() =>
      root.render(
        <Tooltip delayDuration={0} enabledOnMobile>
          <TooltipTrigger asChild passive>
            <View
              focusable
              accessibilityLabel="Select a profile before sending"
              testID="disabled-help"
            >
              <Pressable
                disabled
                accessibilityRole="button"
                accessibilityLabel="Send message"
                onPress={press}
                onLongPress={longPress}
              >
                <Text>Send</Text>
              </Pressable>
            </View>
          </TooltipTrigger>
          <TooltipContent>
            <Text>Select a profile before sending</Text>
          </TooltipContent>
        </Tooltip>,
      ),
    );
    const wrapper = container.querySelector<HTMLElement>('[data-testid="disabled-help"]');
    const button = container.querySelector<HTMLButtonElement>('[role="button"]');
    if (!wrapper || !button) throw new Error("Disabled Send fixture did not render");
    expect(container.querySelectorAll('[role="button"]').length).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await userEvent.hover(wrapper);
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent)
      .toBe("Select a profile before sending");
    expect(wrapper.getAttribute("aria-describedby")).toBe(
      document.querySelector('[role="tooltip"]')?.id,
    );
    await userEvent.unhover(wrapper);
    await expectRemoved();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(wrapper);
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent)
      .toBe("Select a profile before sending");
    await userEvent.keyboard("{Enter} ");
    await userEvent.click(wrapper);
    expect(press).not.toHaveBeenCalled();
    expect(longPress).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expectRemoved();
    expect(document.activeElement).toBe(wrapper);
  });
});
