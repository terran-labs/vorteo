import { isWeb } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { openExternalUrl } from "@/utils/open-external-url";

/**
 * Opens a URL that is only known after an async step (minting a pairing ticket).
 *
 * Browsers, Safari above all, block `window.open` once the tap's user activation is spent, so
 * plain web opens a blank tab during the tap and points it at the URL later. The tab's opener is
 * cleared first: the page it ends on is agent-authored and must not reach this window. Electron
 * and native hand the URL to the system browser, which has no popup blocker to dodge.
 */
export function openBrowserLater(): { go: (url: string) => Promise<void>; cancel: () => void } {
  const tab =
    isWeb && typeof getDesktopHost()?.opener?.openUrl !== "function"
      ? window.open("", "_blank")
      : null;
  if (tab) tab.opener = null;
  return {
    go: async (url) => {
      if (tab && !tab.closed) {
        tab.location.href = url;
        return;
      }
      await openExternalUrl(url);
    },
    cancel: () => tab?.close(),
  };
}
