/**
 * ReelsTogether – Background Service Worker
 *
 * Responsibilities:
 *  • Maintain a single WebSocket connection to the relay server.
 *  • Route messages between the server and the active content script.
 *  • Persist party state (code, role) across popup open/close cycles.
 */

"use strict";

// ── Configuration ──────────────────────────────────────────────────────────
const SERVER_URL = "ws://localhost:8080";
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 25000;

// ── State ──────────────────────────────────────────────────────────────────
/** @type {WebSocket|null} */
let ws = null;
let reconnectTimer = null;
let pingTimer = null;

/** @type {{ code: string|null, role: string|null, connected: boolean }} */
let partyState = { code: null, role: null, connected: false };

// ── WebSocket helpers ──────────────────────────────────────────────────────

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(SERVER_URL);

  ws.addEventListener("open", () => {
    partyState.connected = true;
    broadcastToContentScripts({ type: "ws_connected" });
    startPing();
    clearReconnect();
  });

  ws.addEventListener("message", ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    partyState.connected = false;
    stopPing();
    broadcastToContentScripts({ type: "ws_disconnected" });
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // close event will fire afterward; reconnect there
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

// ── Server → extension routing ─────────────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case "party_created":
      partyState.code = msg.code;
      partyState.role = "host";
      broadcastToPopup(msg);
      break;

    case "party_joined":
      partyState.code = msg.code;
      partyState.role = "guest";
      broadcastToPopup(msg);
      break;

    case "sync_state":
      // Forward playback sync to the active content script
      broadcastToContentScripts(msg);
      break;

    case "state_request":
      // Server asks us (as host) to send current state to a new member
      broadcastToContentScripts(msg);
      break;

    case "member_joined":
    case "member_left":
    case "host_left":
      broadcastToPopup(msg);
      broadcastToContentScripts(msg);
      break;

    case "error":
      broadcastToPopup(msg);
      break;

    case "pong":
      // keep-alive acknowledged
      break;

    default:
      break;
  }
}

// ── Content script / popup broadcast helpers ───────────────────────────────

function broadcastToContentScripts(payload) {
  chrome.tabs.query({ url: ["https://www.instagram.com/*", "https://www.youtube.com/*"] }, (tabs) => {
    if (!tabs) return;
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
  });
}

function broadcastToPopup(payload) {
  // Send to all extension views (popup)
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// ── Extension message handler (from popup & content scripts) ───────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "get_state":
      sendResponse({ ...partyState });
      return true;

    case "create_party":
      connect();
      send({ type: "create_party" });
      break;

    case "join_party":
      connect();
      send({ type: "join_party", code: msg.code });
      break;

    case "leave_party":
      send({ type: "leave_party" });
      partyState.code = null;
      partyState.role = null;
      broadcastToPopup({ type: "left_party" });
      broadcastToContentScripts({ type: "left_party" });
      break;

    case "sync_state":
      // Content script sends its current playback state to relay
      send({ type: "sync_state", state: msg.state });
      break;

    case "state_response":
      // Host content script sends state back for a new joiner
      send({ type: "state_response", state: msg.state, targetId: msg.targetId });
      break;

    case "connect_ws":
      connect();
      break;

    default:
      break;
  }
});

// ── Startup ────────────────────────────────────────────────────────────────
connect();
