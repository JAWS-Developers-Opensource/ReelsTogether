# ReelsTogether

**Watch Instagram Reels and YouTube Shorts together with friends — in real time.**

ReelsTogether is a Chrome extension paired with a lightweight WebSocket relay server.  
One person creates a *party* and shares the 6-character code; everyone else joins with that code.  
The **host** controls playback and every guest follows automatically.

---

## Repository layout

```
ReelsTogether/
├── extension/          Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js   Service worker – WS connection & message routing
│   ├── content.js      Content script – video capture & sync on Instagram/YouTube
│   ├── popup.html/css/js  Extension popup UI
│   └── icons/          Extension icons (16 × 16, 48 × 48, 128 × 128)
└── server/             Node.js WebSocket relay server
    ├── server.js
    ├── package.json
    └── tests/
        └── server.test.js
```

---

## How it works

```
  Host browser                  Relay server                Guest browser
  ────────────                  ────────────                ─────────────
  [content.js]  ──play/pause──► [server.js]  ──sync_state──► [content.js]
  [popup.js]    ──create_party─►            ◄─party_created─ [popup.js]
                                            ◄─join_party──── [popup.js]
```

1. The host opens Instagram Reels or YouTube Shorts and clicks **Create Party**.  
2. The server issues a unique 6-character party code and stores the host's WebSocket.  
3. Guests enter the code in the popup and click **Join Party**.  
4. Every time the host plays, pauses, or seeks, the content script sends a `sync_state` message to the server, which broadcasts it to all other party members.  
5. Each guest's content script receives `sync_state` and adjusts the local video accordingly.

---

## Getting started

### 1 — Start the relay server

```bash
cd server
npm install
npm start          # listens on ws://localhost:8080 by default
```

To use a different port:

```bash
PORT=9090 npm start
```

### 2 — Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder
4. The ReelsTogether icon appears in the toolbar

### 3 — Update the server URL (optional)

If you're running the server on a remote host, edit the `SERVER_URL` constant at the top of `extension/background.js`:

```js
const SERVER_URL = "wss://your-server.example.com";
```

Then reload the extension in Chrome.

---

## Using the extension

| Step | Action |
|------|--------|
| 1 | Navigate to Instagram Reels (`instagram.com/reels`) or YouTube Shorts (`youtube.com/shorts`) |
| 2 | Click the ReelsTogether toolbar icon |
| 3 | **Host**: click **Create Party** → share the 6-character code |
| 4 | **Guests**: paste the code → click **Join** |
| 5 | The host controls playback; all guests sync automatically |
| 6 | Click **Leave Party** to disconnect |

---

## Running the tests

```bash
cd server
npm test
```

Runs all 15 integration + unit tests with the Node.js built-in test runner.

---

## Deploying the server

The relay server is a standard Node.js process. It can be deployed to any platform that supports WebSockets (Railway, Fly.io, Render, a plain VPS, etc.).

Example with a reverse-proxy (Nginx):

```nginx
location /ws {
    proxy_pass         http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "Upgrade";
}
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3 (vanilla JS, no bundler required) |
| Transport | WebSocket (`ws` npm package) |
| Server | Node.js ≥ 18 |
| Room IDs | 6-char alphanumeric codes (ambiguous chars excluded) |

---

## License

MIT
