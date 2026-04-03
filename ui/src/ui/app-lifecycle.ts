import { connectGateway } from "./app-gateway.ts";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
  startSecurityPolling,
  stopSecurityPolling,
} from "./app-polling.ts";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import { getAllQueueItems } from "./db.ts";
import type { Tab } from "./navigation.ts";
import type { ChatQueueItem } from "./ui-types.ts";

type LifecycleHost = {
  basePath: string;
  tab: Tab;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  chatHasAutoScrolled: boolean;
  chatManualRefreshInFlight: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string;
  chatQueue: ChatQueueItem[];
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
  _viewportResizeHandler: (() => void) | null;
};

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[sw] service worker registration failed:", err);
    });
  }
}

function loadPersistedQueue(host: LifecycleHost) {
  getAllQueueItems()
    .then((items) => {
      if (items.length > 0 && host.chatQueue.length === 0) {
        host.chatQueue = items;
      }
    })
    .catch((err) => {
      console.warn("[chat-queue] failed to load persisted queue from IndexedDB:", err);
    });
}

export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    (window as any).__openclawInstallPrompt = e;
  });
}

export function handleConnected(host: LifecycleHost) {
  captureInstallPrompt();
  registerServiceWorker();
  loadPersistedQueue(host);
  host.basePath = inferBasePath();
  void loadControlUiBootstrapConfig(host);
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  attachThemeListener(host as unknown as Parameters<typeof attachThemeListener>[0]);
  window.addEventListener("popstate", host.popStateHandler);
  connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (host.tab === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (host.tab === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
  if (host.tab === "security") {
    startSecurityPolling(host as unknown as Parameters<typeof startSecurityPolling>[0]);
  }

  // Track virtual keyboard height via visualViewport API so the chat
  // compose area can shift above the on-screen keyboard on mobile.
  if (window.visualViewport) {
    const updateKeyboardHeight = () => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      const keyboardHeight = Math.max(0, window.innerHeight - viewport.height);
      document.documentElement.style.setProperty(
        "--keyboard-height",
        `${keyboardHeight}px`,
      );
    };
    host._viewportResizeHandler = updateKeyboardHeight;
    window.visualViewport.addEventListener("resize", updateKeyboardHeight);
    // Set initial value
    updateKeyboardHeight();
  } else {
    host._viewportResizeHandler = null;
  }
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  stopSecurityPolling(host as unknown as Parameters<typeof stopSecurityPolling>[0]);
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;

  // Clean up visualViewport listener
  if (host._viewportResizeHandler && window.visualViewport) {
    window.visualViewport.removeEventListener("resize", host._viewportResizeHandler);
    host._viewportResizeHandler = null;
    document.documentElement.style.removeProperty("--keyboard-height");
  }
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (host.tab === "chat" && host.chatManualRefreshInFlight) {
    return;
  }
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
}
