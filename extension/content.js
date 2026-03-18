/**
 * ReelsTogether – Content Script
 *
 * Injected into Instagram and YouTube pages.
 *
 * Responsibilities:
 *  • Detect the active video element (Reel / Short).
 *  • When in a party as HOST: capture play/pause/seek/navigation events and
 *    forward them to the background service worker for broadcast.
 *  • When in a party as GUEST: receive sync_state messages and apply them to
 *    the local video element.
 *  • When the server requests a state snapshot (state_request), respond with
 *    the current playback position.
 */

"use strict";

// ── State ──────────────────────────────────────────────────────────────────
let partyCode = null;
let role = null;       // "host" | "guest" | null
let isSyncing = false; // prevent feedback loops while applying remote state

// ── Utilities ──────────────────────────────────────────────────────────────

/**
 * Find the most prominent video element on the page.
 * For Instagram Reels the video is inside `article` or a full-viewport div.
 * For YouTube Shorts it is inside `#shorts-player`.
 * @returns {HTMLVideoElement|null}
 */
function findVideo() {
  // Prefer visible, playing (or paused) videos with meaningful duration
  const candidates = Array.from(document.querySelectorAll("video"))
    .filter((v) => v.readyState >= 1 && v.duration > 0);

  if (candidates.length === 0) return null;

  // Prefer the largest visible video
  return candidates.reduce((best, v) => {
    const area = v.offsetWidth * v.offsetHeight;
    const bestArea = best.offsetWidth * best.offsetHeight;
    return area > bestArea ? v : best;
  });
}

/** @returns {string} Current page URL cleaned of query params */
function currentVideoUrl() {
  return window.location.href.split("?")[0];
}

/** Send a message to the background service worker */
function bgSend(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// ── Host: capture playback events ─────────────────────────────────────────

let attachedVideo = null;

const hostHandlers = {
  play(e) {
    if (isSyncing || role !== "host") return;
    bgSend({
      type: "sync_state",
      state: { action: "play", currentTime: e.target.currentTime, paused: false, videoUrl: currentVideoUrl() },
    });
  },
  pause(e) {
    if (isSyncing || role !== "host") return;
    bgSend({
      type: "sync_state",
      state: { action: "pause", currentTime: e.target.currentTime, paused: true, videoUrl: currentVideoUrl() },
    });
  },
  seeked(e) {
    if (isSyncing || role !== "host") return;
    bgSend({
      type: "sync_state",
      state: { action: "seek", currentTime: e.target.currentTime, paused: e.target.paused, videoUrl: currentVideoUrl() },
    });
  },
};

function attachHostListeners(video) {
  if (attachedVideo === video) return;
  detachHostListeners();
  attachedVideo = video;
  video.addEventListener("play", hostHandlers.play);
  video.addEventListener("pause", hostHandlers.pause);
  video.addEventListener("seeked", hostHandlers.seeked);
}

function detachHostListeners() {
  if (!attachedVideo) return;
  attachedVideo.removeEventListener("play", hostHandlers.play);
  attachedVideo.removeEventListener("pause", hostHandlers.pause);
  attachedVideo.removeEventListener("seeked", hostHandlers.seeked);
  attachedVideo = null;
}

// ── Guest: apply remote state ──────────────────────────────────────────────

function applyState(state) {
  const video = findVideo();
  if (!video) return;

  // If the URL differs, navigate (best-effort for SPA pages)
  if (state.videoUrl && !window.location.href.startsWith(state.videoUrl)) {
    // Only navigate if it's the same origin to stay safe
    try {
      const target = new URL(state.videoUrl);
      if (target.origin === window.location.origin) {
        window.location.href = state.videoUrl;
        return;
      }
    } catch {
      // invalid URL – ignore
    }
  }

  isSyncing = true;

  const SEEK_THRESHOLD = 1.5; // seconds
  if (Math.abs(video.currentTime - state.currentTime) > SEEK_THRESHOLD) {
    video.currentTime = state.currentTime;
  }

  if (state.action === "play" || !state.paused) {
    video.play().catch(() => {});
  } else if (state.action === "pause" || state.paused) {
    video.pause();
  }

  setTimeout(() => { isSyncing = false; }, 300);
}

// ── Background message listener ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "party_created":
      partyCode = msg.code;
      role = "host";
      scheduleAttach();
      break;

    case "party_joined":
      partyCode = msg.code;
      role = "guest";
      detachHostListeners();
      break;

    case "left_party":
    case "host_left":
      partyCode = null;
      role = null;
      detachHostListeners();
      break;

    case "sync_state":
      if (role === "guest") {
        applyState(msg.state);
      }
      break;

    case "state_request":
      // Server asks the host to report current state for a new member
      if (role === "host") {
        const video = findVideo();
        if (video) {
          bgSend({
            type: "state_response",
            targetId: msg.targetId,
            state: {
              action: video.paused ? "pause" : "play",
              currentTime: video.currentTime,
              paused: video.paused,
              videoUrl: currentVideoUrl(),
            },
          });
        }
      }
      break;

    default:
      break;
  }
});

// ── Periodic video attachment (for SPAs that swap video elements) ──────────

function scheduleAttach() {
  if (role !== "host") return;
  const video = findVideo();
  if (video) {
    attachHostListeners(video);
  }
}

// Re-attach whenever the DOM changes significantly (SPA navigation)
const observer = new MutationObserver(() => {
  if (role === "host") scheduleAttach();
});
observer.observe(document.body, { childList: true, subtree: true });

// Sync on page navigation events (YouTube Shorts uses History API)
window.addEventListener("popstate", () => {
  if (role === "host") {
    setTimeout(scheduleAttach, 500);
  }
});

// ── Init: restore state from background ───────────────────────────────────

chrome.runtime.sendMessage({ type: "get_state" }).then((state) => {
  if (state && state.code) {
    partyCode = state.code;
    role = state.role;
    if (role === "host") scheduleAttach();
  }
}).catch(() => {});
