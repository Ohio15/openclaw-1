/**
 * Claude Gateway PWA — OpenClaw Edition
 *
 * WebSocket layer rewritten for OpenClaw's JSON-RPC style protocol.
 * UI logic (DOM manipulation, markdown, tool cards, sessions) is unchanged.
 *
 * Protocol mapping:
 *   Client -> Server: { type: "req", id: N, method: "...", params: {...} }
 *   Server -> Client: { type: "res", id: N, ok: true, payload: {...} }
 *                     { type: "event", event: "...", payload: {...} }
 *
 * Key events:
 *   "chat" with payload.state = "delta" | "final" | "error" | "aborted"
 */

// ── OpenClaw Protocol Layer ───────────────────────────────────

const PRESET_API = '/gateway/presets';

// Build WS URL pointing to OpenClaw gateway (default port 18789)
const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
let WS_URL = `${wsProto}://${window.location.hostname}:18789`;

let ws = null;
let currentSessionId = null;
let isStreaming = false;
let presets = [];
let sessions = [];
let userScrolledUp = false;

// Auth: OpenClaw uses a password-based auth in the connect frame
let authPassword = '';
(function loadAuth() {
  const stored = localStorage.getItem('openclaw_gateway_password');
  const expiresAt = localStorage.getItem('openclaw_gateway_password_expires_at');
  if (stored) {
    if (expiresAt && Date.now() > Number(expiresAt)) {
      localStorage.removeItem('openclaw_gateway_password');
      localStorage.removeItem('openclaw_gateway_password_expires_at');
      authPassword = '';
    } else {
      authPassword = stored;
    }
  }
})();

function storeAuth(password) {
  localStorage.setItem('openclaw_gateway_password', password);
  localStorage.setItem('openclaw_gateway_password_expires_at', String(Date.now() + 24 * 60 * 60 * 1000));
}

// RPC request ID counter
let rpcIdCounter = 0;
function nextRpcId() {
  return String(++rpcIdCounter);
}

// Pending RPC responses: id -> { resolve, reject, method }
const pendingRequests = new Map();

// Send an RPC request and return a promise for the response
function rpcSend(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WebSocket not connected'));
      return;
    }
    const id = nextRpcId();
    const frame = { type: 'req', id, method, params: params || {} };
    pendingRequests.set(id, { resolve, reject, method });
    ws.send(JSON.stringify(frame));

    // Timeout after 60s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }
    }, 60000);
  });
}

// Fire-and-forget RPC (no response tracking)
function rpcFire(method, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const id = nextRpcId();
  ws.send(JSON.stringify({ type: 'req', id, method, params: params || {} }));
}

// Configure marked for markdown rendering
if (typeof marked !== 'undefined') {
  marked.setOptions({
    highlight: (code, lang) => {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return code;
    },
    breaks: true,
    gfm: true,
  });
}

// DOM elements
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const presetInteractive = document.getElementById('preset-interactive');
const presetAutomatedToggle = document.getElementById('preset-automated-toggle');
const presetAutomated = document.getElementById('preset-automated');
const automatedCount = document.getElementById('automated-count');
const sessionList = document.getElementById('session-list');
const quickPresets = document.getElementById('quick-presets');
const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const statusDot = document.getElementById('status-dot');
const statusPopover = document.getElementById('status-popover');
const statusPopoverContent = document.getElementById('status-popover-content');
const alertBadge = document.getElementById('alert-badge');
const newSessionBtn = document.getElementById('new-session-btn');
const streamingIndicator = document.getElementById('streaming-indicator');
const streamingTextEl = document.getElementById('streaming-text');
const streamingTimerEl = document.getElementById('streaming-timer');
const contextBar = document.getElementById('context-bar');
const contextBarFill = contextBar ? contextBar.querySelector('.context-bar-fill') : null;
const contextBarLabel = contextBar ? contextBar.querySelector('.context-bar-label') : null;
let lastHealthData = null;
let streamingTimerInterval = null;
let streamingStartTime = null;
const CONTEXT_MAX_TOKENS = 200000;
const connectionBanner = document.getElementById('connection-banner');
const welcomeInput = document.getElementById('welcome-input');
const welcomeSendBtn = document.getElementById('welcome-send-btn');
const recentSessionsEl = document.getElementById('recent-sessions');
const healthSummaryEl = document.getElementById('health-summary');
const shortcutsBtn = document.getElementById('shortcuts-btn');
const shortcutsPopover = document.getElementById('shortcuts-popover');
let disconnectedAt = null;
let disconnectCheckInterval = null;

// Track the connect challenge nonce from the server
let connectNonce = null;
// Track whether we've completed the connect handshake
let wsConnected = false;
// Snapshot received from hello-ok
let serverSnapshot = null;

// ── WebSocket ───────────────────────────────────────────────

function connectWS() {
  if (ws && ws.readyState <= 1) return;

  if (!authPassword) {
    console.log('[WS] Skipping connect - no auth password');
    return;
  }

  console.log('[WS] Connecting to:', WS_URL);
  wsConnected = false;
  connectNonce = null;

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.error('[WS] Constructor threw:', e);
    statusDot.className = 'status-dot error';
    statusDot.title = 'WS error: ' + e.message;
    setTimeout(connectWS, 10000);
    return;
  }

  ws.onopen = () => {
    console.log('[WS] Connected, waiting for challenge...');
    statusDot.className = 'status-dot warning';
    statusDot.title = 'Authenticating...';
    disconnectedAt = null;
    if (disconnectCheckInterval) { clearInterval(disconnectCheckInterval); disconnectCheckInterval = null; }
  };

  ws.onclose = (evt) => {
    console.log('[WS] Closed: code=' + evt.code + ' reason=' + evt.reason);
    statusDot.className = 'status-dot error';
    statusDot.title = 'Reconnecting...';
    wsConnected = false;
    if (ws._pingInterval) clearInterval(ws._pingInterval);
    if (!disconnectedAt) disconnectedAt = Date.now();
    showConnectionBanner('reconnecting');
    if (!disconnectCheckInterval) {
      disconnectCheckInterval = setInterval(() => {
        if (disconnectedAt && (Date.now() - disconnectedAt) > 30000) {
          showConnectionBanner('lost');
        }
      }, 5000);
    }
    // Clear any pending RPC requests
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error('WebSocket closed'));
    }
    pendingRequests.clear();
    setTimeout(connectWS, 5000);
  };

  ws.onerror = (evt) => {
    console.error('[WS] Error event:', evt);
    statusDot.className = 'status-dot error';
    statusDot.title = 'Connection error';
  };

  ws.onmessage = (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch {
      console.warn('[WS] Invalid JSON:', evt.data);
      return;
    }

    // Handle connect challenge from OpenClaw
    if (data.type === 'event' && data.event === 'connect.challenge') {
      connectNonce = data.payload?.nonce;
      console.log('[WS] Got challenge, sending connect frame...');
      sendConnectFrame();
      return;
    }

    // Handle hello-ok response (successful auth)
    if (data.type === 'hello-ok') {
      console.log('[WS] Authenticated successfully, protocol v' + data.protocol);
      wsConnected = true;
      serverSnapshot = data.snapshot;
      statusDot.className = 'status-dot connected';
      statusDot.title = 'Connected (v' + (data.server?.version || '?') + ')';
      startWsPing();
      showConnectionBanner('connected');

      // Update status popover with server info
      if (statusPopoverContent && data.server) {
        statusPopoverContent.innerHTML =
          '<div class="status-row"><span class="status-label">Server</span><span class="status-value">v' +
          escapeHtml(data.server.version || '?') + '</span></div>' +
          '<div class="status-row"><span class="status-label">Protocol</span><span class="status-value">v' +
          escapeHtml(String(data.protocol || '?')) + '</span></div>';
      }

      // Now load data
      loadPresets();
      refreshSessions();
      return;
    }

    // Handle RPC responses
    if (data.type === 'res' && data.id) {
      const pending = pendingRequests.get(data.id);
      if (pending) {
        pendingRequests.delete(data.id);
        if (data.ok) {
          pending.resolve(data.payload);
        } else {
          pending.reject(new Error(data.error?.message || 'RPC error'));
        }
      }
      return;
    }

    // Handle server events
    if (data.type === 'event') {
      handleServerEvent(data.event, data.payload);
      return;
    }
  };
}

function sendConnectFrame() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const connectParams = {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: 'claude-gateway-pwa',
      displayName: 'Gateway PWA',
      version: '2.0.0',
      platform: navigator.platform || 'web',
      mode: 'webchat',
    },
    caps: ['chat', 'tool-events'],
    auth: {
      password: authPassword,
    },
  };

  // Send as the first RPC request (id must match expected pattern)
  const id = nextRpcId();
  const frame = { type: 'req', id, method: 'connect', params: connectParams };
  ws.send(JSON.stringify(frame));
}

function startWsPing() {
  if (ws._pingInterval) clearInterval(ws._pingInterval);
  ws._pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      rpcFire('ping');
    }
  }, 30000);
}

// ── Server Event Handling ─────────────────────────────────────

let streamingMessageEl = null;
let streamingText = '';
let firstUserMessage = '';
// Track which runId we're currently streaming
let activeRunId = null;

function handleServerEvent(eventName, payload) {
  if (eventName === 'chat') {
    handleChatEvent(payload);
    return;
  }

  if (eventName === 'agent') {
    handleAgentEvent(payload);
    return;
  }

  if (eventName === 'tool') {
    handleToolEvent(payload);
    return;
  }

  if (eventName === 'tick') {
    // Heartbeat — ignore
    return;
  }

  if (eventName === 'snapshot') {
    serverSnapshot = payload;
    return;
  }
}

function handleChatEvent(payload) {
  if (!payload) return;

  const state = payload.state;
  const sessionKey = payload.sessionKey;

  // Only process events for the current session
  if (sessionKey && currentSessionId && sessionKey !== currentSessionId) {
    return;
  }

  if (state === 'delta') {
    // Streaming text delta
    const message = payload.message;
    if (!message) return;

    const content = message.content;
    if (!Array.isArray(content)) return;

    if (!isStreaming) {
      isStreaming = true;
      sendBtn.disabled = true;
      streamingIndicator.style.display = 'flex';
      streamingTextEl.textContent = 'Claude is thinking...';
      startStreamingTimer();
    }

    activeRunId = payload.runId;

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        if (!streamingMessageEl) {
          streamingMessageEl = addMarkdownMessage('assistant', '');
          streamingText = '';
        }
        streamingText += block.text;
        renderMarkdown(streamingMessageEl, streamingText);
        streamingTextEl.textContent = 'Claude is responding...';
        scrollToBottom();
      }
    }
  } else if (state === 'final') {
    // Stream complete
    const message = payload.message;
    if (message) {
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            if (!streamingMessageEl) {
              streamingMessageEl = addMarkdownMessage('assistant', '');
              streamingText = '';
            }
            streamingText += block.text;
            renderMarkdown(streamingMessageEl, streamingText);
          }
        }
      }
    }
    finishStreaming();
  } else if (state === 'error') {
    addMessage('error', payload.errorMessage || 'Unknown error');
    finishStreaming();
  } else if (state === 'aborted') {
    addMessage('system-msg', 'Response aborted');
    finishStreaming();
  }
}

function handleAgentEvent(payload) {
  if (!payload) return;

  // Agent lifecycle events — update streaming status
  if (payload.state === 'running') {
    if (!isStreaming) {
      isStreaming = true;
      sendBtn.disabled = true;
      streamingIndicator.style.display = 'flex';
      startStreamingTimer();
    }
    streamingTextEl.textContent = 'Claude is working...';
  }
}

function handleToolEvent(payload) {
  if (!payload) return;

  const toolName = payload.name || payload.toolName || 'Tool';

  if (payload.state === 'start' || payload.type === 'tool_use') {
    // Flush current assistant message before tool card
    if (streamingMessageEl) {
      addCopyButton(streamingMessageEl, streamingText);
      streamingMessageEl = null;
      streamingText = '';
    }
    const input = typeof payload.input === 'string'
      ? payload.input
      : JSON.stringify(payload.input || {}, null, 2).substring(0, 200);
    addToolCard(toolName, input, 'running');
    streamingTextEl.textContent = TOOL_LABELS[toolName] || ('Using ' + toolName + '...');
  } else if (payload.state === 'end' || payload.type === 'tool_result') {
    // Tool finished
    if (streamingMessageEl) {
      addCopyButton(streamingMessageEl, streamingText);
      streamingMessageEl = null;
      streamingText = '';
    }
    const lastCard = messagesEl.querySelector('.tool-card:last-of-type');
    if (lastCard) {
      const statusEl = lastCard.querySelector('.tool-status');
      if (statusEl) statusEl.classList.remove('running');
    }
    streamingTextEl.textContent = 'Claude is responding...';
  }
}

function finishStreaming() {
  isStreaming = false;
  sendBtn.disabled = false;
  streamingIndicator.style.display = 'none';
  stopStreamingTimer();
  activeRunId = null;

  if (streamingMessageEl) {
    addCopyButton(streamingMessageEl, streamingText);
    addTimestamp(streamingMessageEl, 'assistant');
  }

  if (firstUserMessage && currentSessionId) {
    autoGenerateTitle(currentSessionId, firstUserMessage);
    firstUserMessage = '';
  }

  streamingMessageEl = null;
  streamingText = '';
  refreshSessions();
}

// ── UI helpers ──────────────────────────────────────────────

const TOOL_LABELS = {
  Bash: 'Running command...',
  Read: 'Reading file...',
  Write: 'Writing file...',
  Edit: 'Editing file...',
  Grep: 'Searching code...',
  Glob: 'Finding files...',
  WebSearch: 'Searching web...',
  Agent: 'Delegating task...',
  WebFetch: 'Fetching page...',
  ToolSearch: 'Searching tools...',
};

function addMessage(type, text) {
  const el = document.createElement('div');
  el.className = 'message ' + type;
  el.textContent = text;
  if (type === 'user') addTimestamp(el, 'user');
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addMarkdownMessage(type, text) {
  const el = document.createElement('div');
  el.className = 'message ' + type;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function renderMarkdown(el, text) {
  if (typeof marked !== 'undefined') {
    const rawHtml = marked.parse(text);
    el.innerHTML = typeof DOMPurify !== 'undefined'
      ? DOMPurify.sanitize(rawHtml)
      : rawHtml;
    if (typeof hljs !== 'undefined') {
      el.querySelectorAll('pre code').forEach(block => {
        if (!block.dataset.highlighted) {
          hljs.highlightElement(block);
          block.dataset.highlighted = 'true';
        }
      });
    }
    el.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.code-copy-btn')) return;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        const codeEl = pre.querySelector('code');
        const codeText = codeEl ? codeEl.textContent : pre.textContent;
        try {
          await navigator.clipboard.writeText(codeText);
          copyBtn.textContent = '\u2713 Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 2000);
        } catch { /* clipboard API may not be available */ }
      };
      pre.appendChild(copyBtn);
    });
  } else {
    el.textContent = text;
  }
}

function addCopyButton(messageEl, rawText) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const btn = document.createElement('button');
  btn.className = 'msg-action-btn';
  btn.innerHTML = '\uD83D\uDCCB';
  btn.title = 'Copy';
  btn.onclick = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(rawText);
      btn.classList.add('copied');
      btn.innerHTML = '\u2713';
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = '\uD83D\uDCCB'; }, 2000);
    } catch { /* clipboard API may not be available */ }
  };
  actions.appendChild(btn);
  messageEl.appendChild(actions);
}

function addTimestamp(el, type) {
  const ts = document.createElement('div');
  ts.className = 'msg-time';
  ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.appendChild(ts);
}

function addToolCard(name, content, status) {
  const icons = {Bash:'\u{1F4BB}',Read:'\u{1F4C4}',Write:'\u{270D}',Edit:'\u{270F}',Glob:'\u{1F4C2}',Grep:'\u{1F50D}',Agent:'\u{1F916}',WebSearch:'\u{1F310}',WebFetch:'\u{1F310}',ToolSearch:'\u{1F527}'};
  const icon = icons[name] || '\u2699\uFE0F';
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML =
    '<div class="tool-card-header">' +
      '<span class="tool-icon">' + icon + '</span>' +
      '<span class="tool-name">' + escapeHtml(name) + '</span>' +
      (status === 'running' ? '<span class="tool-status running streaming-dot" style="width:6px;height:6px"></span>' : '') +
      '<span class="tool-toggle">\u25B6</span>' +
    '</div>' +
    '<div class="tool-card-body">' + escapeHtml(content) + '</div>';
  const header = card.querySelector('.tool-card-header');
  const body = card.querySelector('.tool-card-body');
  const toggle = card.querySelector('.tool-toggle');
  header.onclick = () => {
    body.classList.toggle('expanded');
    toggle.classList.toggle('open');
  };
  messagesEl.appendChild(card);
  scrollToBottom();
}

function scrollToBottom() {
  if (!userScrolledUp) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ── Pull to refresh chat (reload messages) ────────────────────
(function() {
  const chatMessages = document.getElementById('messages');
  if (!chatMessages) return;

  let startY = 0, pulling = false;
  const threshold = 60;

  chatMessages.addEventListener('touchstart', (e) => {
    if (chatMessages.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  chatMessages.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) { pulling = false; return; }
  }, { passive: true });

  chatMessages.addEventListener('touchend', async (event) => {
    if (!pulling) return;
    pulling = false;

    if (currentSessionId && event && event.changedTouches) {
      const endY = event.changedTouches[0].clientY;
      if (endY - startY >= threshold) {
        await switchSession(currentSessionId);
      }
    }
  });
})();

// Detect manual scroll-up to pause auto-scroll
messagesEl.addEventListener('scroll', () => {
  const threshold = 100;
  const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
  userScrolledUp = !atBottom;
});

function showChat() {
  welcomeEl.style.display = 'none';
  messagesEl.classList.add('active');
  document.getElementById('input-area').style.display = 'flex';
  userScrolledUp = false;
}

function showWelcome() {
  welcomeEl.style.display = 'flex';
  messagesEl.classList.remove('active');
  messagesEl.innerHTML = '';
  document.getElementById('input-area').style.display = 'none';
  currentSessionId = null;
  streamingMessageEl = null;
  streamingText = '';
  activeRunId = null;
  resetContextBar();
  stopStreamingTimer();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Send message ────────────────────────────────────────────

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isStreaming || !wsConnected) return;
  navigator.vibrate?.(10);

  if (!currentSessionId || currentSessionId.startsWith('pending-')) {
    firstUserMessage = text;
  }

  addMessage('user', text);
  messageInput.value = '';
  messageInput.style.height = 'auto';

  // Generate an idempotency key for the chat.send request
  const idempotencyKey = 'gw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // If no session selected, use 'main' as the default session key
  const sessionKey = currentSessionId || 'main';

  rpcSend('chat.send', {
    sessionKey: sessionKey,
    message: text,
    idempotencyKey: idempotencyKey,
  }).then((result) => {
    // chat.send returns { runId, status: "started" } immediately
    if (result && result.runId) {
      activeRunId = result.runId;
      // If we had no session, adopt this key
      if (!currentSessionId) {
        currentSessionId = sessionKey;
        showChat();
      }
    }
  }).catch((err) => {
    console.error('[Chat] Send failed:', err);
    addMessage('error', 'Send failed: ' + err.message);
  });

  // Show streaming UI immediately for responsiveness
  isStreaming = true;
  sendBtn.disabled = true;
  streamingIndicator.style.display = 'flex';
  streamingTextEl.textContent = 'Claude is thinking...';
  startStreamingTimer();
}

// ── Preset handling ─────────────────────────────────────────

async function loadPresets() {
  try {
    const result = await rpcSend('preset.list', {});
    presets = result?.presets || [];
    renderPresets();
  } catch (e) {
    console.error('Failed to load presets:', e);
    // Fallback: try HTTP API
    try {
      const res = await fetch(PRESET_API);
      if (res.ok) {
        const data = await res.json();
        presets = data.presets || [];
        renderPresets();
      }
    } catch { /* ignore fallback error */ }
  }
}

const PRESET_ICONS = {
  'general-assistant': '\u2728',
  'incident-responder': '\uD83D\uDEA8',
  'deploy-guardian': '\uD83D\uDE80',
  'security-scanner': '\uD83D\uDD12',
  'sentinel-monitor': '\uD83D\uDCE1',
  'brain-curator': '\uD83E\uDDE0',
  'code-reviewer': '\uD83D\uDD0D',
  'log-analyst': '\uD83D\uDCCA',
  'performance-profiler': '\u26A1',
  'network-monitor': '\uD83C\uDF10',
  'infrastructure-ops': '\uD83D\uDD27',
  'backup-verifier': '\uD83D\uDCBE',
  'cost-tracker': '\uD83D\uDCB0',
  'dependency-guardian': '\uD83D\uDCE6',
  'documentation-curator': '\uD83D\uDCDD',
};

function renderPresets() {
  const interactive = presets.filter(p =>
    p.tags?.includes('interactive') || p.tags?.includes('general') ||
    (p.tags?.includes('tier-1') && !p.schedule)
  );
  const automated = presets.filter(p => p.schedule);

  presetInteractive.innerHTML = interactive.map(p =>
    '<div class="preset-item" data-preset="' + escapeHtml(p.name) + '" title="' + escapeHtml(p.description) + '">' +
      '<div class="preset-icon">' + (PRESET_ICONS[p.name] || '\u2699\uFE0F') + '</div>' +
      '<div class="preset-info">' +
        '<div class="preset-name">' + escapeHtml(p.display_name) + '</div>' +
        '<div class="preset-desc">' + escapeHtml(p.description).substring(0, 50) + '</div>' +
      '</div>' +
    '</div>'
  ).join('');

  presetInteractive.querySelectorAll('.preset-item').forEach(el => {
    el.onclick = () => startPresetSession(el.dataset.preset);
  });

  if (automated.length) {
    presetAutomatedToggle.style.display = 'flex';
    automatedCount.textContent = automated.length + ' scheduled';

    presetAutomated.innerHTML = automated.map(p =>
      '<div class="preset-item" data-preset="' + escapeHtml(p.name) + '" title="' + escapeHtml(p.description) + '">' +
        '<div class="preset-icon">' + (PRESET_ICONS[p.name] || '\u2699\uFE0F') + '</div>' +
        '<div class="preset-info">' +
          '<div class="preset-name">' + escapeHtml(p.display_name) + '</div>' +
          '<div class="preset-desc">' + escapeHtml(p.schedule || '') + '</div>' +
        '</div>' +
      '</div>'
    ).join('');

    presetAutomated.querySelectorAll('.preset-item').forEach(el => {
      el.onclick = () => startPresetSession(el.dataset.preset);
    });
  }

  const quickList = [...interactive, ...automated.filter(p => p.tags?.includes('tier-1'))].slice(0, 4);
  quickPresets.innerHTML = quickList.map(p =>
    '<button class="preset-btn" data-preset="' + escapeHtml(p.name) + '" title="' + escapeHtml(p.description) + '" style="min-width:130px">' +
      '<span class="preset-name">' + escapeHtml(p.display_name) + '</span>' +
      '<span class="preset-tag">' + escapeHtml(p.description).substring(0, 45) + '...</span>' +
    '</button>'
  ).join('');

  quickPresets.querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => startPresetSession(btn.dataset.preset);
  });
}

// Automated presets toggle
if (presetAutomatedToggle) {
  presetAutomatedToggle.onclick = () => {
    const chevron = presetAutomatedToggle.querySelector('.automated-chevron');
    const isOpen = presetAutomated.classList.toggle('expanded');
    chevron.classList.toggle('open', isOpen);
  };
}

function startPresetSession(presetName) {
  if (!wsConnected) return;
  showChat();
  addMessage('system-msg', 'Starting ' + presetName + '...');

  rpcSend('preset.run', { name: presetName }).then((result) => {
    if (result && result.cronJobId) {
      addMessage('system-msg', 'Preset started (job: ' + result.cronJobId + ')');
    }
    refreshSessions();
  }).catch((err) => {
    addMessage('error', 'Failed to start preset: ' + err.message);
  });

  closeSidebar();
}

// ── Session handling ────────────────────────────────────────

async function refreshSessions() {
  try {
    const result = await rpcSend('sessions.list', { limit: 30 });
    // OpenClaw sessions.list returns an array of session entries
    const rawSessions = result?.sessions || result || [];

    // Map OpenClaw session format to our UI format
    sessions = (Array.isArray(rawSessions) ? rawSessions : []).map(s => ({
      id: s.key || s.sessionKey || s.id,
      title: s.label || s.title || s.key || 'Untitled',
      message_count: s.messageCount || s.turns || 0,
      created_at: s.createdAt || s.created,
      updated_at: s.lastActiveAt || s.updatedAt || s.updated || s.createdAt,
      last_message_preview: s.preview || s.lastMessage || '',
    }));

    renderSessions();
  } catch (e) {
    console.error('Failed to load sessions:', e);
  }
}

function renderSessions() {
  if (!sessions.length) {
    sessionList.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 4px">No sessions yet</div>';
    return;
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);

  const groups = { Today: [], Yesterday: [], 'This Week': [], Older: [] };

  for (const s of sessions) {
    const d = new Date(s.updated_at || s.created_at);
    if (isNaN(d.getTime())) { groups.Today.push(s); continue; }
    if (d >= today) groups.Today.push(s);
    else if (d >= yesterday) groups.Yesterday.push(s);
    else if (d >= weekAgo) groups['This Week'].push(s);
    else groups.Older.push(s);
  }

  let html = '';
  for (const [label, items] of Object.entries(groups)) {
    if (!items.length) continue;
    html += '<div class="session-group-label">' + label + '</div>';
    html += items.map(s =>
      '<div class="session-item ' + (s.id === currentSessionId ? 'active' : '') + '" data-id="' + escapeHtml(s.id) + '">' +
        '<div class="session-title">' + escapeHtml(deriveSessionTitle(s)) + '</div>' +
        '<div class="session-meta">' +
          '<span class="msg-count">' + s.message_count + '</span>' +
          '<span>' + formatTime(s.updated_at) + '</span>' +
        '</div>' +
        '<button class="session-delete" data-id="' + escapeHtml(s.id) + '" title="Delete">\u2715</button>' +
      '</div>'
    ).join('');
  }

  sessionList.innerHTML = html;

  sessionList.querySelectorAll('.session-item').forEach(el => {
    el.onclick = (e) => {
      if (e.target.closest('.session-delete')) return;
      switchSession(el.dataset.id);
    };
  });

  sessionList.querySelectorAll('.session-delete').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      try {
        await rpcSend('sessions.delete', { key: id });
      } catch { /* ignore */ }
      if (currentSessionId === id) showWelcome();
      refreshSessions();
    };
  });

  renderRecentSessions();
}

async function switchSession(sessionId) {
  currentSessionId = sessionId;
  messagesEl.innerHTML = '';
  showChat();
  renderSessions();
  closeSidebar();
  resetContextBar();

  // Load conversation history via chat.history
  try {
    const result = await rpcSend('chat.history', { sessionKey: sessionId, limit: 200 });
    const messages = result?.messages || [];

    if (messages.length > 0) {
      let lastAssistantEl = null;
      let lastAssistantText = '';
      let pendingTools = [];

      function flushTools() {
        if (pendingTools.length === 0) return;
        if (pendingTools.length === 1) {
          const t = pendingTools[0];
          addToolCard(t.name, t.input);
        } else {
          const names = pendingTools.map(t => t.name);
          const counts = {};
          names.forEach(n => counts[n] = (counts[n] || 0) + 1);
          const summary = Object.entries(counts).map(([n, c]) => c > 1 ? n + ' \u00d7' + c : n).join(', ');
          addToolCard(summary, pendingTools.length + ' tool calls', 'group');
        }
        pendingTools = [];
      }

      for (const msg of messages) {
        const role = msg.role;
        const content = msg.content;

        if (role === 'user') {
          flushTools();
          if (lastAssistantEl && lastAssistantText) {
            renderMarkdown(lastAssistantEl, lastAssistantText);
            lastAssistantEl = null;
            lastAssistantText = '';
          }
          // Content can be string or array of blocks
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : '';
          if (text) addMessage('user', text);
        } else if (role === 'assistant') {
          if (typeof content === 'string') {
            flushTools();
            if (!lastAssistantEl) {
              lastAssistantEl = addMarkdownMessage('assistant', '');
            }
            lastAssistantText += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                flushTools();
                if (!lastAssistantEl) {
                  lastAssistantEl = addMarkdownMessage('assistant', '');
                }
                lastAssistantText += block.text;
              } else if (block.type === 'tool_use') {
                if (lastAssistantEl && lastAssistantText) {
                  renderMarkdown(lastAssistantEl, lastAssistantText);
                  lastAssistantEl = null;
                  lastAssistantText = '';
                }
                const input = typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input || {}, null, 2);
                const truncInput = input.length > 200 ? input.substring(0, 200) + '...' : input;
                pendingTools.push({ name: block.name || 'Tool', input: truncInput });
              }
            }
          }
        }
      }

      flushTools();
      if (lastAssistantEl && lastAssistantText) {
        renderMarkdown(lastAssistantEl, lastAssistantText);
      }

      scrollToBottom();
      return;
    }
  } catch (e) {
    console.error('Failed to load session history:', e);
  }

  // Fallback: show session info
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    addMessage('system-msg', (session.title || 'Session') + ' \u00b7 ' + session.message_count + ' messages');
    if (session.last_message_preview) {
      const previewEl = addMarkdownMessage('assistant', '');
      renderMarkdown(previewEl, session.last_message_preview);
    }
  }
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Context bar ────────────────────────────────────────────

function updateContextBar(tokens, level) {
  if (!contextBar || !contextBarFill || !contextBarLabel) return;

  const pct = Math.min((tokens / CONTEXT_MAX_TOKENS) * 100, 100);

  contextBar.style.display = 'block';

  contextBarFill.style.width = pct + '%';
  contextBarFill.classList.remove('warning', 'error', 'critical');

  if (pct >= 95) {
    contextBarFill.classList.add('error', 'critical');
  } else if (pct >= 85) {
    contextBarFill.classList.add('error');
  } else if (pct >= 70) {
    contextBarFill.classList.add('warning');
  }

  const tokensK = Math.round(tokens / 1000);
  const maxK = Math.round(CONTEXT_MAX_TOKENS / 1000);
  contextBarLabel.textContent = tokensK + 'k / ' + maxK + 'k';
}

function resetContextBar() {
  if (!contextBar || !contextBarFill) return;
  contextBar.style.display = 'none';
  contextBarFill.style.width = '0%';
  contextBarFill.classList.remove('warning', 'error', 'critical');
  if (contextBarLabel) contextBarLabel.textContent = '';
}

// ── Streaming timer ────────────────────────────────────────

function startStreamingTimer() {
  stopStreamingTimer();
  streamingStartTime = Date.now();
  streamingTimerEl.textContent = '(0s)';
  streamingTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - streamingStartTime) / 1000);
    streamingTimerEl.textContent = '(' + elapsed + 's)';
  }, 1000);
}

function stopStreamingTimer() {
  if (streamingTimerInterval) {
    clearInterval(streamingTimerInterval);
    streamingTimerInterval = null;
  }
  streamingStartTime = null;
  if (streamingTimerEl) streamingTimerEl.textContent = '';
}

// ── Session auto-title ─────────────────────────────────────

function deriveSessionTitle(session) {
  if (session.title && session.title !== 'Untitled') return session.title;
  if (session.last_message_preview) {
    return truncateForTitle(session.last_message_preview);
  }
  return 'New session';
}

function truncateForTitle(text) {
  let clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/[#*_~>\[\]]/g, '')
    .replace(/\n+/g, ' ')
    .trim();

  if (clean.length > 40) {
    clean = clean.substring(0, 40).trimEnd() + '...';
  }

  return clean || 'New session';
}

async function autoGenerateTitle(sessionId, userMessage) {
  const title = truncateForTitle(userMessage);
  const sessionItem = sessionList.querySelector('[data-id="' + sessionId + '"] .session-title');
  if (sessionItem && (sessionItem.textContent === 'New session' || sessionItem.textContent === 'Untitled')) {
    sessionItem.textContent = title;
  }
  const session = sessions.find(s => s.id === sessionId);
  if (session && (!session.title || session.title === 'Untitled')) {
    session.title = title;
  }
  // Attempt to persist via sessions.patch
  try {
    await rpcSend('sessions.patch', { key: sessionId, label: title });
  } catch {
    // Not critical — local update is sufficient
  }
}

// ── Mobile sidebar ──────────────────────────────────────────

function closeSidebar() {
  sidebar.classList.remove('open');
}

sidebarToggle.onclick = () => sidebar.classList.toggle('open');
sidebarOverlay.onclick = closeSidebar;

let touchStartX = 0;
sidebar.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
sidebar.addEventListener('touchmove', (e) => {
  const dx = e.touches[0].clientX - touchStartX;
  if (dx < -50) closeSidebar();
}, { passive: true });

// ── Input handling ──────────────────────────────────────────

function autoResizeInput() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
}

messageInput.addEventListener('input', autoResizeInput);

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.onclick = sendMessage;

newSessionBtn.onclick = () => {
  showWelcome();
  closeSidebar();
};

// ── Alerts ──────────────────────────────────────────────────

async function checkAlerts() {
  try {
    const result = await rpcSend('preset.alerts', {});
    const alerts = result?.alerts || [];
    const recent = alerts.filter(a => {
      const age = (Date.now() - new Date(a.timestamp).getTime()) / 3600000;
      return age < 24;
    });

    if (recent.length > 0) {
      const critical = recent.filter(a => a.severity === 'critical').length;
      const warning = recent.filter(a => a.severity === 'warning').length;
      let text = '';
      if (critical) text += critical + ' critical';
      if (warning) text += (text ? ', ' : '') + warning + ' warning';
      alertBadge.textContent = '\u26A0 ' + text + ' alert' + (recent.length > 1 ? 's' : '') + ' (24h)';
      alertBadge.style.display = 'block';
    } else {
      alertBadge.style.display = 'none';
    }
  } catch { /* ignore */ }
}

// ── Auth / Login ────────────────────────────────────────────

const loginScreen = document.getElementById('login-screen');
const loginBtn = document.getElementById('login-btn');
const loginToken = document.getElementById('login-token');
const loginError = document.getElementById('login-error');
const appEl = document.getElementById('app');

function checkAuthRequired() {
  // If we have a stored password, try connecting immediately
  if (authPassword) {
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginScreen.style.display = 'block';
  appEl.style.display = 'none';
  if (loginToken) loginToken.focus();
}

function showApp() {
  loginScreen.style.display = 'none';
  appEl.style.display = 'flex';
  document.getElementById('input-area').style.display = 'none';
  connectWS();
  // Periodic alert check
  setInterval(checkAlerts, 60000);
}

async function attemptLogin() {
  const password = loginToken.value.trim();
  if (!password) return;

  // Store and attempt connect
  authPassword = password;
  storeAuth(password);
  loginError.style.display = 'none';
  showApp();
}

if (loginBtn) {
  loginBtn.onclick = attemptLogin;
  loginToken.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });
}

// ── Connection banner ──────────────────────────────────────

function showConnectionBanner(state) {
  if (!connectionBanner) return;
  connectionBanner.className = '';
  connectionBanner.textContent = '';

  if (state === 'connected') {
    connectionBanner.className = 'visible connected';
    connectionBanner.textContent = 'Connected';
    setTimeout(() => {
      connectionBanner.style.transition = 'opacity 0.5s';
      connectionBanner.style.opacity = '0';
      setTimeout(() => {
        connectionBanner.className = '';
        connectionBanner.style.transition = '';
        connectionBanner.style.opacity = '';
      }, 500);
    }, 2000);
  } else if (state === 'reconnecting') {
    connectionBanner.className = 'visible reconnecting';
    connectionBanner.textContent = 'Reconnecting...';
  } else if (state === 'lost') {
    connectionBanner.className = 'visible';
    connectionBanner.textContent = '';
    const textSpan = document.createElement('span');
    textSpan.textContent = 'Connection lost';
    const btn = document.createElement('button');
    btn.className = 'reconnect-btn';
    btn.textContent = 'Reconnect';
    btn.onclick = () => {
      disconnectedAt = null;
      if (disconnectCheckInterval) { clearInterval(disconnectCheckInterval); disconnectCheckInterval = null; }
      showConnectionBanner('reconnecting');
      connectWS();
    };
    connectionBanner.appendChild(textSpan);
    connectionBanner.appendChild(btn);
  }
}

// ── Welcome screen logic ──────────────────────────────────

function sendFromWelcome() {
  const text = welcomeInput ? welcomeInput.value.trim() : '';
  if (!text || isStreaming || !wsConnected) return;
  navigator.vibrate?.(10);
  firstUserMessage = text;
  currentSessionId = 'main';
  showChat();
  addMessage('user', text);
  welcomeInput.value = '';

  const idempotencyKey = 'gw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  rpcSend('chat.send', {
    sessionKey: 'main',
    message: text,
    idempotencyKey: idempotencyKey,
  }).catch((err) => {
    addMessage('error', 'Send failed: ' + err.message);
  });

  isStreaming = true;
  sendBtn.disabled = true;
  streamingIndicator.style.display = 'flex';
  streamingTextEl.textContent = 'Claude is thinking...';
  startStreamingTimer();
}

if (welcomeInput) {
  welcomeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendFromWelcome(); }
  });
}
if (welcomeSendBtn) {
  welcomeSendBtn.onclick = sendFromWelcome;
}

function renderRecentSessions() {
  if (!recentSessionsEl) return;
  const recent = sessions.slice(0, 3);
  if (!recent.length) { recentSessionsEl.innerHTML = ''; return; }

  recentSessionsEl.innerHTML = recent.map(s => {
    const title = deriveSessionTitle(s);
    const time = formatTime(s.updated_at);
    return '<div class="recent-card" data-id="' + escapeHtml(s.id) + '">' +
      '<div class="recent-title">' + escapeHtml(title) + '</div>' +
      '<div class="recent-time">' + escapeHtml(time) + '</div>' +
    '</div>';
  }).join('');

  recentSessionsEl.querySelectorAll('.recent-card').forEach(card => {
    card.onclick = () => switchSession(card.dataset.id);
  });
}

function renderHealthSummary() {
  if (!healthSummaryEl) return;
  if (serverSnapshot) {
    healthSummaryEl.textContent = 'OpenClaw Gateway';
  }
}

// ── Status dot popover ───────────────────────────────────────

if (statusDot) {
  statusDot.onclick = (e) => {
    e.stopPropagation();
    statusPopover.classList.toggle('visible');
  };
  document.addEventListener('click', () => statusPopover.classList.remove('visible'));
}

// ── Keyboard shortcuts ────────────────────────────────────

if (shortcutsBtn) {
  shortcutsBtn.onclick = (e) => {
    e.stopPropagation();
    shortcutsPopover.classList.toggle('visible');
  };
}

document.addEventListener('keydown', (e) => {
  const isMod = e.metaKey || e.ctrlKey;

  if (isMod && e.key === 'k') {
    e.preventDefault();
    if (welcomeEl && welcomeEl.style.display !== 'none' && welcomeInput) {
      welcomeInput.focus();
    } else {
      messageInput.focus();
    }
    return;
  }

  if (isMod && e.key === 'n') {
    e.preventDefault();
    newSessionBtn.click();
    return;
  }

  if (isMod && e.key === '/') {
    e.preventDefault();
    sidebar.classList.toggle('open');
    return;
  }

  if (e.key === 'Escape') {
    const isMobile = window.innerWidth <= 768;
    if (isMobile && sidebar.classList.contains('open')) {
      closeSidebar();
    } else if (document.activeElement === messageInput || document.activeElement === welcomeInput) {
      document.activeElement.blur();
    }
    if (shortcutsPopover) shortcutsPopover.classList.remove('visible');
    return;
  }
});

document.addEventListener('click', (e) => {
  if (shortcutsPopover && !e.target.closest('#shortcuts-btn') && !e.target.closest('#shortcuts-popover')) {
    shortcutsPopover.classList.remove('visible');
  }
});

// ── Long-press copy on messages (mobile) ──────────────────

(function() {
  let longPressTimer = null;
  let longPressTarget = null;
  let startTouchY = 0;
  let activeCopyBtn = null;

  function dismissCopyBtn() {
    if (activeCopyBtn) {
      activeCopyBtn.remove();
      activeCopyBtn = null;
    }
  }

  messagesEl.addEventListener('touchstart', (e) => {
    const msgEl = e.target.closest('.message');
    if (!msgEl) return;
    longPressTarget = msgEl;
    startTouchY = e.touches[0].clientY;
    longPressTimer = setTimeout(() => {
      const rect = msgEl.getBoundingClientRect();
      const touchX = e.touches[0].clientX;
      dismissCopyBtn();

      const btn = document.createElement('button');
      btn.className = 'longpress-copy-btn';
      btn.textContent = 'Copy';
      btn.style.left = Math.min(touchX, window.innerWidth - 80) + 'px';
      btn.style.top = (rect.top - 40) + 'px';
      btn.onclick = async () => {
        const text = msgEl.textContent || '';
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = 'Copied!';
          setTimeout(dismissCopyBtn, 800);
        } catch {
          dismissCopyBtn();
        }
      };
      document.body.appendChild(btn);
      activeCopyBtn = btn;
      navigator.vibrate?.(15);
    }, 500);
  }, { passive: true });

  messagesEl.addEventListener('touchmove', (e) => {
    if (longPressTimer && Math.abs(e.touches[0].clientY - startTouchY) > 10) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }, { passive: true });

  messagesEl.addEventListener('touchend', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  document.addEventListener('touchstart', (e) => {
    if (activeCopyBtn && !e.target.closest('.longpress-copy-btn')) {
      dismissCopyBtn();
    }
  }, { passive: true });
})();

// ── Swipe-to-delete session items (mobile) ────────────────

(function() {
  let swipeTarget = null;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swiping = false;
  let swipeDistance = 0;

  sessionList.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.session-item');
    if (!item) return;
    swipeTarget = item;
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swiping = false;
    swipeDistance = 0;
  }, { passive: true });

  sessionList.addEventListener('touchmove', (e) => {
    if (!swipeTarget) return;
    const dx = e.touches[0].clientX - swipeStartX;
    const dy = e.touches[0].clientY - swipeStartY;

    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      swiping = true;
    }
    if (!swiping) return;

    swipeDistance = Math.max(0, dx);
    swipeTarget.style.transform = 'translateX(' + swipeDistance + 'px)';
    swipeTarget.style.transition = 'none';

    if (swipeDistance > 0 && !swipeTarget.dataset.deleteBg) {
      swipeTarget.style.background = 'linear-gradient(90deg, var(--error) 0%, var(--error) ' + Math.min(swipeDistance, 80) + 'px, transparent ' + Math.min(swipeDistance, 80) + 'px)';
      swipeTarget.style.backgroundSize = '100%';
    }
  }, { passive: true });

  sessionList.addEventListener('touchend', async () => {
    if (!swipeTarget || !swiping) {
      swipeTarget = null;
      return;
    }

    const item = swipeTarget;
    const dist = swipeDistance;
    swipeTarget = null;
    swiping = false;
    swipeDistance = 0;

    if (dist > 80) {
      item.style.transition = 'transform 0.2s, opacity 0.2s';
      item.style.transform = 'translateX(' + window.innerWidth + 'px)';
      item.style.opacity = '0';
      const id = item.dataset.id;
      setTimeout(async () => {
        try {
          await rpcSend('sessions.delete', { key: id });
          if (currentSessionId === id) showWelcome();
          refreshSessions();
        } catch { /* ignore */ }
      }, 200);
    } else {
      item.style.transition = 'transform 0.2s, background 0.2s';
      item.style.transform = '';
      item.style.background = '';
    }
  });
})();

// ── iOS keyboard fix ──────────────────────────────────────

(function() {
  if (!window.visualViewport) return;
  const inputArea = document.getElementById('input-area');
  if (!inputArea) return;

  window.visualViewport.addEventListener('resize', () => {
    const offset = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
    if (offset > 0) {
      inputArea.style.paddingBottom = (14 + offset) + 'px';
    } else {
      inputArea.style.paddingBottom = '';
    }
  });

  messageInput.addEventListener('blur', () => {
    inputArea.style.paddingBottom = '';
  });
})();

// ── Init ────────────────────────────────────────────────────

checkAuthRequired();

// ── Pull to refresh (iOS-style) ───────────────────────────

(function() {
  const container = document.getElementById('sidebar');
  const indicator = document.getElementById('pull-indicator');
  if (!container || !indicator) return;

  let startY = 0;
  let pulling = false;
  const threshold = 60;

  container.addEventListener('touchstart', (e) => {
    if (container.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) { pulling = false; return; }

    indicator.style.height = Math.min(dy * 0.5, 50) + 'px';
    indicator.classList.add('pulling');
    indicator.classList.toggle('threshold', dy >= threshold);

    const text = indicator.querySelector('.pull-text');
    if (dy >= threshold) {
      if (text) text.textContent = 'Release to refresh';
    } else {
      if (text) text.textContent = 'Pull to refresh';
    }
  }, { passive: true });

  container.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;

    const wasThreshold = indicator.classList.contains('threshold');
    indicator.classList.remove('pulling', 'threshold');

    if (wasThreshold) {
      indicator.classList.add('refreshing');
      indicator.innerHTML = '<div class="pull-spinner"></div><span>Refreshing...</span>';

      await refreshSessions();
      await checkAlerts();

      setTimeout(() => {
        indicator.classList.remove('refreshing');
        indicator.style.height = '0';
        indicator.innerHTML = '<span class="pull-arrow">\u2193</span><span class="pull-text">Pull to refresh</span>';
      }, 400);
    } else {
      indicator.style.height = '0';
    }
  });
})();

// Unregister any existing service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    for (const reg of regs) {
      reg.unregister().then(() => console.log('[SW] Unregistered:', reg.scope));
    }
  });
  if ('caches' in window) {
    caches.keys().then(keys => {
      keys.forEach(k => caches.delete(k));
    });
  }
}
