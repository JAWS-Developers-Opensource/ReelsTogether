/**
 * ReelsTogether – Popup Script
 */

"use strict";

// ── DOM refs ──────────────────────────────────────────────────────────────
const statusBar     = document.getElementById("status-bar");
const statusText    = document.getElementById("status-text");
const sectionLobby  = document.getElementById("section-lobby");
const sectionParty  = document.getElementById("section-party");

const btnCreate     = document.getElementById("btn-create");
const inputCode     = document.getElementById("input-code");
const btnJoin       = document.getElementById("btn-join");
const joinError     = document.getElementById("join-error");

const partyCodeEl   = document.getElementById("party-code-display");
const btnCopy       = document.getElementById("btn-copy");
const copyConfirm   = document.getElementById("copy-confirm");
const partyRoleEl   = document.getElementById("party-role");
const partyMembersEl= document.getElementById("party-members");
const roleHint      = document.getElementById("role-hint");
const btnLeave      = document.getElementById("btn-leave");

// ── Local state ───────────────────────────────────────────────────────────
let memberCount = 1;

// ── Helpers ───────────────────────────────────────────────────────────────

function bgSend(payload) {
  return chrome.runtime.sendMessage(payload);
}

function showLobby() {
  sectionLobby.classList.remove("hidden");
  sectionParty.classList.add("hidden");
  joinError.classList.add("hidden");
  inputCode.value = "";
}

function showParty(code, role, count) {
  sectionLobby.classList.add("hidden");
  sectionParty.classList.remove("hidden");

  partyCodeEl.textContent = code;
  memberCount = count || memberCount;
  partyMembersEl.textContent = memberCount;

  partyRoleEl.textContent  = role === "host" ? "Host" : "Guest";
  partyRoleEl.className    = `badge badge-${role}`;

  roleHint.textContent = role === "host"
    ? "You control playback. Others will follow your video."
    : "The host controls playback. Sit back and enjoy!";
}

function setStatus(connected) {
  if (connected) {
    statusBar.className = "status-bar connected";
    statusText.textContent = "Connected";
  } else {
    statusBar.className = "status-bar disconnected";
    statusText.textContent = "Server unreachable";
  }
}

// ── Init: fetch current state from background ─────────────────────────────

bgSend({ type: "get_state" }).then((state) => {
  if (!state) return;
  setStatus(state.connected);
  if (state.code) {
    showParty(state.code, state.role);
  } else {
    showLobby();
  }
}).catch(() => showLobby());

// ── Button handlers ───────────────────────────────────────────────────────

btnCreate.addEventListener("click", () => {
  btnCreate.disabled = true;
  bgSend({ type: "create_party" });
});

btnJoin.addEventListener("click", () => {
  const code = inputCode.value.trim().toUpperCase();
  if (code.length !== 6) {
    joinError.textContent = "Please enter a 6-character party code.";
    joinError.classList.remove("hidden");
    return;
  }
  joinError.classList.add("hidden");
  btnJoin.disabled = true;
  bgSend({ type: "join_party", code });
});

inputCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnJoin.click();
});

btnLeave.addEventListener("click", () => {
  bgSend({ type: "leave_party" });
  showLobby();
});

btnCopy.addEventListener("click", () => {
  const code = partyCodeEl.textContent;
  navigator.clipboard.writeText(code).then(() => {
    copyConfirm.classList.remove("hidden");
    setTimeout(() => copyConfirm.classList.add("hidden"), 2000);
  }).catch(() => {});
});

// ── Background message listener ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "party_created":
      btnCreate.disabled = false;
      memberCount = 1;
      showParty(msg.code, "host", 1);
      break;

    case "party_joined":
      btnJoin.disabled = false;
      showParty(msg.code, "guest", msg.memberCount);
      break;

    case "left_party":
      showLobby();
      break;

    case "member_joined":
      memberCount = msg.memberCount;
      partyMembersEl.textContent = memberCount;
      break;

    case "member_left":
      memberCount = msg.memberCount;
      partyMembersEl.textContent = memberCount;
      break;

    case "host_left":
      // We've been promoted to host
      partyRoleEl.textContent = "Host";
      partyRoleEl.className   = "badge badge-host";
      roleHint.textContent    = "You are now the host. You control playback.";
      break;

    case "ws_connected":
      setStatus(true);
      break;

    case "ws_disconnected":
      setStatus(false);
      break;

    case "error":
      btnCreate.disabled = false;
      btnJoin.disabled   = false;
      joinError.textContent = msg.message || "An error occurred.";
      joinError.classList.remove("hidden");
      break;

    default:
      break;
  }
});
