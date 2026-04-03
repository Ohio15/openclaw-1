/**
 * Mobile gesture integration for the chat view.
 * Wires touch swipe/pull gestures to existing sidebar and refresh mechanisms.
 * Only active on viewports narrower than 600px.
 */

import { GestureDetector } from "./gestures.ts";

const MOBILE_MAX_WIDTH = 600;

type GestureHost = {
  sidebarOpen: boolean;
  sidebarContent: string | null;
  handleOpenSidebar(content: string): void;
  handleCloseSidebar(): void;
  resetToolStream(): void;
  querySelector(selector: string): Element | null;
  updateComplete: Promise<unknown>;
};

type RefreshFn = () => void;

let activeDetector: GestureDetector | null = null;
let mediaQuery: MediaQueryList | null = null;
let mqListener: ((e: MediaQueryListEvent) => void) | null = null;

/**
 * Set up touch gestures on the chat container.
 *
 * - Swipe right on chat: opens tool sidebar (if tool output exists)
 * - Swipe left on chat: closes the sidebar
 * - Pull down on chat thread: triggers refresh/reconnect
 *
 * Call this once after the chat view is first rendered.
 * Call `teardownChatGestures()` on disconnect to clean up.
 */
export function setupChatGestures(host: GestureHost, onRefresh: RefreshFn): void {
  teardownChatGestures();

  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

  mediaQuery = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);

  const tryAttach = () => {
    if (!mediaQuery?.matches) {
      activeDetector?.detach();
      activeDetector = null;
      return;
    }

    // Wait for Lit render to complete so the chat container exists in DOM
    void host.updateComplete.then(() => {
      const container = host.querySelector(".chat-split-container") as HTMLElement | null;
      if (!container) return;

      // Already attached to this container
      if (activeDetector) return;

      activeDetector = new GestureDetector(container, {
        onSwipeRight: () => {
          // Open sidebar only if there is tool content to show
          if (!host.sidebarOpen && host.sidebarContent) {
            host.handleOpenSidebar(host.sidebarContent);
          }
        },
        onSwipeLeft: () => {
          if (host.sidebarOpen) {
            host.handleCloseSidebar();
          }
        },
        onPullDown: () => {
          onRefresh();
        },
      });
      activeDetector.attach();
    });
  };

  mqListener = (e: MediaQueryListEvent) => {
    if (e.matches) {
      tryAttach();
    } else {
      activeDetector?.detach();
      activeDetector = null;
    }
  };

  mediaQuery.addEventListener("change", mqListener);
  tryAttach();
}

/** Remove all gesture listeners and clean up state. */
export function teardownChatGestures(): void {
  activeDetector?.detach();
  activeDetector = null;

  if (mediaQuery && mqListener) {
    mediaQuery.removeEventListener("change", mqListener);
  }
  mediaQuery = null;
  mqListener = null;
}
