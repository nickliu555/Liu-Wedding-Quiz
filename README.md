# Liu Wedding Quiz

A Kahoot-style real-time quiz web app for ~150 wedding guests. Guests scan a QR code on the big
screen, enter a name on their phone, and answer 4-choice time-pressured questions. A host laptop
drives the projector view (lobby, question, live answer distribution, top-5 leaderboard between
questions, top-3 podium reveal at the end). Faster correct answers score more points.

## Stack
- Node.js + Express + Socket.IO (single game, in-memory state)
- Vanilla JS/HTML/CSS (no build step)
- Questions in a JSON file (`data/questions.json`)

## Quick start (local)

```
npm install
npm start
```

Then open:
- **Host / big screen:** http://localhost:3000/host
- **Player join:** http://localhost:3000/join (or scan the QR on the host screen)

Run tests:

```
npm test
```

## Testing on a phone over your local network

The server binds to `0.0.0.0` and the `/config` endpoint computes the canonical join URL from the
host machine's LAN IP. The QR code on `/host` automatically encodes that LAN URL, so a phone on
the same WiFi can scan it and connect — even when the host page itself is loaded via
`http://localhost`.

If your phone can't reach the laptop:

1. Confirm both devices are on the same network (laptop on Ethernet + phone on WiFi works as long
   as both are on the same router).
2. On Windows, set the network profile to **Private** (not Public). Public profiles block
   incoming connections by default.
3. Allow inbound TCP on the server port through Windows Firewall. One-time PowerShell command
   (run as Administrator):

   ```powershell
   New-NetFirewallRule -DisplayName "Liu Quiz App" -Direction Inbound `
     -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any
   ```

## Authoring questions

Edit `data/questions.json`. Schema:

```json
{
  "questions": [
    {
      "id": "q1",
      "prompt": "Where did the couple first meet?",
      "image": "/assets/images/optional.jpg",
      "choices": ["A", "B", "C", "D"],
      "correctIndex": 2,
      "timeLimitSec": 20
    }
  ]
}
```

- `choices` must have **exactly 4** entries.
- `correctIndex` is 0..3.
- `timeLimitSec` is optional (default 20s, min 3s, max 120s).
- Optional `image` is served from `/assets/images/` (place files under `assets/images/`).

The server validates the file at boot and exits with a clear error if it's malformed.

## Sound effects

Drop `.mp3` files in `assets/sounds/` (they're optional — missing files just won't play):

- `lobby.mp3` — background loop on the lobby screen
- `tick.mp3` — played in the last 5 seconds of a question
- `reveal.mp3` — played when answers are revealed
- `podium.mp3` — played on the final podium reveal

## Host controls

- **Music** toggles the lobby background track.
- **Fullscreen** uses the Fullscreen API (works without relying on F11).
- **Reset** wipes all players and returns the game to the lobby.
- Click any player tile in the lobby to **kick** that player.
- The host page acquires a screen wake lock so the PC won't sleep while the quiz is running.
- Refreshing the host page mid-game (Ctrl+Shift+R) resumes on the same screen — it does not
  bounce back to the lobby.

## Deploying to Render (optional)

1. Push this repo to GitHub.
2. Create a new **Web Service** on [render.com](https://render.com), pointing to the repo.
3. Render will use `npm install` / `npm start` (see `render.yaml`).
4. Once deployed, the QR on `/host` will point at your Render URL automatically — the server
   reads `RENDER_EXTERNAL_URL` to build the canonical join URL.

**Render free-tier note:** the service spins down after ~15 min idle and cold-starts in ~30s.
Open the URL ~5 minutes before the quiz begins to wake it up.

## Backup plan — local network mode

If venue WiFi is unusable, run the exact same app on a laptop on a local network. The QR auto-
generates from the LAN IP, so **no code changes needed** — just `npm start`.

### Option A — Phone hotspot (emergency only)
Most phone hotspots cap at ~10–20 devices, so this only covers a small subset.

1. Turn on personal hotspot on a phone.
2. Connect the laptop to that hotspot.
3. `npm start` — the terminal prints the LAN IP (e.g. `http://192.168.43.12:3000/join`).
4. Open `/host` in a browser on the laptop. The QR will encode the LAN URL.
5. Guests connect their phones to the same hotspot, then scan the QR.

### Option B — Portable travel router (recommended backup for 150 people)

1. Buy a cheap travel router (e.g. GL.iNet "Mango" or "Beryl", ~$30–50). Power it with a USB
   battery pack — it does not need internet access.
2. Plug the laptop into the router (or connect via WiFi).
3. `npm start`.
4. Open `/host` in the browser — the QR will encode the router's LAN URL.
5. Guests connect their phones to the router's WiFi and scan the QR. Traffic is fully local.

Test this end-to-end with multiple real phones before the event.

## Project layout

```
server/
  index.js          Express + Socket.IO bootstrap
  game.js           Single-room state machine
  scoring.js        Kahoot-style points formula
  questions.js      JSON loader + validator
  profanity.js      Small name blocklist
  *.test.js         Tiny Node-based unit tests
data/
  questions.json    Edit this
assets/
  images/           Optional per-question images
  sounds/           Optional SFX
public/
  join.html, player.html, host.html
  css/              base.css, player.css, host.css
  js/               join.js, player.js, host.js
```
