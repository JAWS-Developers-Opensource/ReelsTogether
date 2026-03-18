/**
 * ReelsTogether – WebSocket relay server
 *
 * Each "party" is identified by a 6-character alphanumeric code.
 * The first member to create a party becomes the host.
 * The host's playback-sync events are broadcast to every other member.
 * Any member can also request a state snapshot from the host.
 *
 * Message protocol (JSON):
 *
 *   Client → Server
 *   ───────────────
 *   { type: "create_party" }
 *   { type: "join_party",  code: "<CODE>" }
 *   { type: "sync_state",  state: { action, currentTime, videoUrl, paused } }
 *   { type: "request_state" }   // new member asks host for current state
 *   { type: "leave_party" }
 *   { type: "ping" }
 *
 *   Server → Client
 *   ───────────────
 *   { type: "party_created",   code: "<CODE>", role: "host" }
 *   { type: "party_joined",    code: "<CODE>", role: "guest", memberCount: N }
 *   { type: "sync_state",      state: { ... } }          // relayed from host
 *   { type: "state_request" }                             // relayed to host
 *   { type: "member_joined",   memberCount: N }
 *   { type: "member_left",     memberCount: N }
 *   { type: "host_left" }
 *   { type: "error",           message: "..." }
 *   { type: "pong" }
 */

"use strict";

const { WebSocketServer, WebSocket } = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;

/** @type {Map<string, { host: WebSocket|null, members: Set<WebSocket> }>} */
const parties = new Map();

/**
 * Generate a unique 6-character party code (uppercase letters + digits).
 * @returns {string}
 */
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (parties.has(code));
  return code;
}

/**
 * Safely send a JSON message to a WebSocket client.
 * @param {WebSocket} ws
 * @param {object} payload
 */
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Broadcast a message to all members of a party except the sender.
 * @param {string} code
 * @param {object} payload
 * @param {WebSocket} [exclude]
 */
function broadcast(code, payload, exclude) {
  const party = parties.get(code);
  if (!party) return;
  for (const member of party.members) {
    if (member !== exclude) {
      send(member, payload);
    }
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  console.log(`ReelsTogether server listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws) => {
  /** @type {string|null} */
  ws._partyCode = null;
  /** @type {"host"|"guest"|null} */
  ws._role = null;
  ws._id = randomUUID();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "create_party": {
        if (ws._partyCode) {
          send(ws, { type: "error", message: "Already in a party" });
          return;
        }
        const code = generateCode();
        parties.set(code, { host: ws, members: new Set([ws]) });
        ws._partyCode = code;
        ws._role = "host";
        send(ws, { type: "party_created", code, role: "host" });
        console.log(`[${code}] Party created by ${ws._id}`);
        break;
      }

      case "join_party": {
        const code = (msg.code || "").toUpperCase().trim();
        if (!code) {
          send(ws, { type: "error", message: "Missing party code" });
          return;
        }
        if (ws._partyCode) {
          send(ws, { type: "error", message: "Already in a party" });
          return;
        }
        const party = parties.get(code);
        if (!party) {
          send(ws, { type: "error", message: "Party not found" });
          return;
        }
        party.members.add(ws);
        ws._partyCode = code;
        ws._role = "guest";
        const memberCount = party.members.size;
        send(ws, { type: "party_joined", code, role: "guest", memberCount });
        broadcast(code, { type: "member_joined", memberCount }, ws);
        // Ask the host to send their current state to the new member
        if (party.host && party.host.readyState === WebSocket.OPEN) {
          send(party.host, { type: "state_request", targetId: ws._id });
          // Store mapping so host response can be routed back
          ws._pendingStateFrom = party.host._id;
        }
        console.log(`[${code}] ${ws._id} joined (${memberCount} members)`);
        break;
      }

      case "sync_state": {
        const code = ws._partyCode;
        if (!code) {
          send(ws, { type: "error", message: "Not in a party" });
          return;
        }
        // Broadcast sync state from any member to all others
        broadcast(code, { type: "sync_state", state: msg.state }, ws);
        break;
      }

      case "state_response": {
        // Host sends back current state targeted at a specific new member
        const code = ws._partyCode;
        if (!code) return;
        const party = parties.get(code);
        if (!party) return;
        for (const member of party.members) {
          if (member._id === msg.targetId) {
            send(member, { type: "sync_state", state: msg.state });
            break;
          }
        }
        break;
      }

      case "request_state": {
        const code = ws._partyCode;
        if (!code) return;
        const party = parties.get(code);
        if (!party || !party.host) return;
        send(party.host, { type: "state_request", targetId: ws._id });
        break;
      }

      case "leave_party": {
        handleLeave(ws);
        break;
      }

      case "ping": {
        send(ws, { type: "pong" });
        break;
      }

      default:
        send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    handleLeave(ws);
  });

  ws.on("error", (err) => {
    console.error(`[ws] Error for ${ws._id}:`, err.message);
  });
});

/**
 * Remove a WebSocket from its party and clean up.
 * @param {WebSocket} ws
 */
function handleLeave(ws) {
  const code = ws._partyCode;
  if (!code) return;

  const party = parties.get(code);
  if (!party) return;

  party.members.delete(ws);
  ws._partyCode = null;
  ws._role = null;

  if (party.members.size === 0) {
    parties.delete(code);
    console.log(`[${code}] Party disbanded (empty)`);
    return;
  }

  const isHost = party.host === ws;

  if (isHost) {
    // Promote the next available member to host
    const [newHost] = party.members;
    party.host = newHost;
    newHost._role = "host";
    send(newHost, { type: "party_created", code, role: "host" });
    broadcast(code, { type: "host_left" }, newHost);
    console.log(`[${code}] Host left; promoted ${newHost._id}`);
  } else {
    const memberCount = party.members.size;
    broadcast(code, { type: "member_left", memberCount });
    console.log(`[${code}] ${ws._id} left (${memberCount} remaining)`);
  }
}

module.exports = { wss, parties, generateCode };
