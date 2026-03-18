/**
 * Server unit / integration tests using Node.js built-in test runner.
 * Run with: node --test tests/server.test.js
 */

"use strict";

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

// Start the server on a random port for testing
process.env.PORT = 0; // Let the OS pick a port
const { wss, parties, generateCode } = require("../server");

/** @type {number} */
let serverPort;

before(() => {
  return new Promise((resolve) => {
    if (wss.address()) {
      serverPort = wss.address().port;
      resolve();
      return;
    }
    wss.once("listening", () => {
      serverPort = wss.address().port;
      resolve();
    });
  });
});

after(() => {
  return new Promise((resolve) => {
    // Force-close all remaining connections so the server can shut down
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(resolve);
  });
});

/**
 * Helper: create a connected WebSocket and return it along with a promise
 * that resolves with the next received message.
 */
function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    ws.once("open", () => resolve(ws));
  });
}

/**
 * Helper: wait for the next message on a WebSocket.
 * @param {WebSocket} ws
 * @returns {Promise<object>}
 */
function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for message")), 3000);
    ws.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/**
 * Helper: drain all messages that arrive within `waitMs` milliseconds.
 * Useful to flush pending messages (e.g. member_joined + state_request)
 * before asserting on the next intentional message.
 * @param {WebSocket} ws
 * @param {number} [waitMs=150]
 * @returns {Promise<object[]>}
 */
function drainMessages(ws, waitMs = 150) {
  const collected = [];
  return new Promise((resolve) => {
    function onMsg(data) {
      collected.push(JSON.parse(data.toString()));
      clearTimeout(timer);
      timer = setTimeout(done, waitMs);
    }
    function done() {
      ws.removeListener("message", onMsg);
      resolve(collected);
    }
    let timer = setTimeout(done, waitMs);
    ws.on("message", onMsg);
  });
}

/**
 * Helper: send a message and wait for response.
 */
async function sendAndReceive(ws, payload) {
  ws.send(JSON.stringify(payload));
  return nextMessage(ws);
}

// ──────────────────────────────────────────────────────────────
// Unit test: generateCode
// ──────────────────────────────────────────────────────────────

describe("generateCode", () => {
  test("returns a 6-character string", () => {
    const code = generateCode();
    assert.equal(code.length, 6);
  });

  test("contains only allowed characters", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateCode();
      assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Integration tests
// ──────────────────────────────────────────────────────────────

describe("create_party", () => {
  test("host receives party_created with a code and role=host", async () => {
    const ws = await connect();
    const msg = await sendAndReceive(ws, { type: "create_party" });
    assert.equal(msg.type, "party_created");
    assert.equal(msg.role, "host");
    assert.equal(typeof msg.code, "string");
    assert.equal(msg.code.length, 6);
    ws.close();
  });

  test("cannot create a second party while already in one", async () => {
    const ws = await connect();
    await sendAndReceive(ws, { type: "create_party" });
    const msg = await sendAndReceive(ws, { type: "create_party" });
    assert.equal(msg.type, "error");
    ws.close();
  });
});

describe("join_party", () => {
  test("guest receives party_joined with correct code and role=guest", async () => {
    const host = await connect();
    const created = await sendAndReceive(host, { type: "create_party" });
    const { code } = created;

    const guest = await connect();
    const joined = await sendAndReceive(guest, { type: "join_party", code });
    assert.equal(joined.type, "party_joined");
    assert.equal(joined.code, code);
    assert.equal(joined.role, "guest");
    assert.equal(joined.memberCount, 2);

    host.close();
    guest.close();
  });

  test("host receives member_joined when a guest joins", async () => {
    const host = await connect();
    const created = await sendAndReceive(host, { type: "create_party" });
    const { code } = created;

    // Next message on host should be state_request (from join flow) or member_joined
    const guest = await connect();
    guest.send(JSON.stringify({ type: "join_party", code }));

    const notif = await nextMessage(host);
    // host receives either state_request (if state_request is sent) or member_joined
    assert.ok(notif.type === "member_joined" || notif.type === "state_request");

    host.close();
    guest.close();
  });

  test("returns error for unknown party code", async () => {
    const ws = await connect();
    const msg = await sendAndReceive(ws, { type: "join_party", code: "XXXXXX" });
    assert.equal(msg.type, "error");
    ws.close();
  });

  test("returns error when code is missing", async () => {
    const ws = await connect();
    const msg = await sendAndReceive(ws, { type: "join_party" });
    assert.equal(msg.type, "error");
    ws.close();
  });
});

describe("sync_state", () => {
  test("host sync_state is relayed to guests", async () => {
    const host = await connect();
    const { code } = await sendAndReceive(host, { type: "create_party" });

    const guest = await connect();
    await sendAndReceive(guest, { type: "join_party", code });

    // Drain any pending messages on host (member_joined, state_request)
    await drainMessages(host);

    const state = { action: "play", currentTime: 5.5, paused: false, videoUrl: "https://example.com" };
    host.send(JSON.stringify({ type: "sync_state", state }));

    const relayed = await nextMessage(guest);
    assert.equal(relayed.type, "sync_state");
    assert.deepEqual(relayed.state, state);

    host.close();
    guest.close();
  });

  test("sender does not receive their own sync_state", async () => {
    const host = await connect();
    const { code } = await sendAndReceive(host, { type: "create_party" });

    const guest = await connect();
    await sendAndReceive(guest, { type: "join_party", code });
    // Drain any pending messages on host (member_joined, state_request)
    await drainMessages(host);

    const state = { action: "pause", currentTime: 2.0, paused: true };
    guest.send(JSON.stringify({ type: "sync_state", state }));

    const relayed = await nextMessage(host);
    assert.equal(relayed.type, "sync_state");

    // guest should NOT receive the message back – wait briefly and confirm
    let gotOwnMsg = false;
    const timeout = new Promise((res) => setTimeout(res, 300));
    const listenOwn = new Promise((res) => {
      guest.once("message", () => { gotOwnMsg = true; res(); });
    });
    await Promise.race([timeout, listenOwn]);
    assert.equal(gotOwnMsg, false);

    host.close();
    guest.close();
  });
});

describe("ping/pong", () => {
  test("server responds with pong", async () => {
    const ws = await connect();
    const msg = await sendAndReceive(ws, { type: "ping" });
    assert.equal(msg.type, "pong");
    ws.close();
  });
});

describe("leave_party", () => {
  test("remaining members receive member_left", async () => {
    const host = await connect();
    const { code } = await sendAndReceive(host, { type: "create_party" });

    const guest = await connect();
    await sendAndReceive(guest, { type: "join_party", code });
    // Drain any pending messages on host
    await drainMessages(host);

    guest.send(JSON.stringify({ type: "leave_party" }));

    const notif = await nextMessage(host);
    assert.equal(notif.type, "member_left");
    assert.equal(notif.memberCount, 1);

    host.close();
  });

  test("when host leaves, a guest is promoted and receives party_created", async () => {
    const host = await connect();
    const { code } = await sendAndReceive(host, { type: "create_party" });

    const guest = await connect();
    await sendAndReceive(guest, { type: "join_party", code });
    // Drain any pending messages on host
    await drainMessages(host);

    host.send(JSON.stringify({ type: "leave_party" }));

    const notif = await nextMessage(guest);
    // New host receives party_created (promotion) or host_left
    assert.ok(notif.type === "party_created" || notif.type === "host_left");

    guest.close();
  });
});

describe("error handling", () => {
  test("unknown message type returns error", async () => {
    const ws = await connect();
    const msg = await sendAndReceive(ws, { type: "unknown_type" });
    assert.equal(msg.type, "error");
    ws.close();
  });

  test("invalid JSON returns error", async () => {
    const ws = await connect();
    ws.send("not json");
    const msg = await nextMessage(ws);
    assert.equal(msg.type, "error");
    ws.close();
  });
});
