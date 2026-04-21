# boxclock

A single-page workout-of-the-day display with a configurable
CrossFit-style interval timer, deployed on Cloudflare. Designed for
two-screen use:

1. **Phone → Chromecast → TV.** Open `threetwone.com` on your phone
   and cast the tab.
2. **Smart TV browser.** Navigate with the remote's arrow keys and
   Enter — every control is a real focusable button.

Static HTML + vanilla JS + CSS for the site itself, with a tiny
Cloudflare Worker (`src/worker.js`) that fronts a KV namespace for
owner-published workouts. No framework, no build step, no package
manager.

---

## File structure

```
/
├── public/             # static assets served to the browser
│   ├── index.html
│   ├── app.js          # timer engine + UI + audio
│   ├── styles.css
│   └── workouts.json   # seed WODs (fallback when KV is empty)
├── src/
│   └── worker.js       # Worker: /api/wod (read) + /api/admin/wod (write)
├── wrangler.jsonc      # Cloudflare Worker config (assets + KV binding)
├── README.md
└── .gitignore
```

## Running locally

The static files in `public/` can be opened directly:

```
open public/index.html        # macOS
xdg-open public/index.html    # Linux
```

`/api/wod` won't respond in local mode — the app falls back to the
`workouts.json` seed. To run the full Worker + KV stack locally:

```
npx wrangler dev
# then visit http://localhost:8787
```

---

## Timer presets

Press `1`–`6` on any keyboard (including most smart-TV remote
keypads) to switch presets. Each remembers its last-used parameters
in `localStorage`.

| Key | Preset     | Defaults                    |
|-----|------------|-----------------------------|
| 1   | AMRAP      | 20:00 countdown             |
| 2   | For Time   | Count-up, optional cap      |
| 3   | EMOM       | 10 rounds × 60s             |
| 4   | Intervals  | 8 × 20s/10s (Tabata button) |
| 5   | Stopwatch  | Count-up, no cap            |
| 6   | Circuit    | Fight Gone Bad button       |

All presets share one engine. See `app.js` § 1 for the internal
model (`segments`, `rounds`, `restBetweenRounds`, `totalCap`).

## Keyboard / remote shortcuts

| Key        | Action                       |
|------------|------------------------------|
| Space      | Start / pause                |
| R          | Reset                        |
| M          | Mute toggle                  |
| ← / →      | Previous / next day          |
| 1–6        | Load preset                  |
| Enter      | Activate focused button      |
| Esc        | Close config panel           |

## Audio

All cues are synthesized with the Web Audio API — no audio files,
works offline. Short beep ≈ 880Hz / 120ms, long tone ≈ 440Hz /
800ms. The last 3 seconds of every segment beep down. Station
transitions fire a single beep; round transitions fire a double
beep; completion fires a long tone.

Mute state persists.

---

## Workouts

`workouts.json` is a flat map keyed by ISO date:

```json
{
  "2026-04-20": {
    "title": "Fran",
    "description": "21-15-9\nThrusters (95/65)\nPull-ups",
    "timer": { "preset": "forTime", "cap": 900 }
  }
}
```

`timer` is optional. When present, selecting that day's workout
pre-configures the timer engine. Shapes by preset:

```jsonc
// AMRAP
{ "preset": "amrap", "cap": 1200 }

// For Time (cap optional)
{ "preset": "forTime", "cap": 900 }

// EMOM
{ "preset": "emom", "rounds": 10, "interval": 60 }

// Intervals / Tabata
{ "preset": "intervals", "rounds": 8, "work": 20, "rest": 10 }

// Stopwatch
{ "preset": "stopwatch" }

// Circuit / Stations
{
  "preset": "circuit",
  "rounds": 3,
  "restBetweenRounds": 60,
  "segments": [
    { "label": "Wall Balls", "seconds": 60, "kind": "station" },
    { "label": "SDHP",       "seconds": 60, "kind": "station" }
  ]
}
```

### Workout sources (render priority)

Every page load resolves today's workout in this order, highest to
lowest:

1. **Local override.** If you used the visitor paste box to save
   your own workout for today (per-device, `localStorage`), that
   wins.
2. **Owner-published KV workout.** Fetched from `/api/wod?date=…`.
3. **Seeded `workouts.json`.** Static fallback.
4. **Empty state.** If none of the above have today, the app shows
   "No workout for this day" and the visitor paste box.

### Visitor paste box (`Use This Workout`)

Anyone can paste their own workout and hit **Use This Workout**.
It's stored in `localStorage` on that browser only — nothing hits
the server. **Remove My Override** clears the local override and
the page falls back to whatever the owner published (or the seed).
**Copy as JSON** gives you a snippet you can paste into
`workouts.json` if you want to persist it to git history.

### Admin publish (`?admin=1`)

Visit `https://threetwone.com/?admin=1` to reveal a second
textarea. Hitting **Publish** POSTs to `/api/admin/wod`, which is
gated by Cloudflare Access. If you're already logged into the same
Access identity as your other site, publishing is seamless — no
password prompt, no token. **Unpublish** deletes the KV entry for
the currently-browsed date.

Only the date being browsed gets published, so you can backfill
yesterday or schedule tomorrow by navigating with ◀ / ▶ first.

---

## Cloudflare deployment

Deploys via **Cloudflare Workers Static Assets** + KV. The
`wrangler.jsonc` at the repo root holds the full config. Production
pushes to `main` run `wrangler deploy` (100% rollout). Feature
branches run `wrangler versions upload` (uploaded but idle).

### One-time setup

```bash
# 1. Create the KV namespaces (run once, save the IDs)
npx wrangler kv namespace create WOD
npx wrangler kv namespace create WOD --preview

# 2. Paste the two ids into wrangler.jsonc under kv_namespaces[0]
```

### Cloudflare Access (owner auth)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Application domain: `threetwone.com` with path `/api/admin/*`.
3. Identity provider: whatever you already use on the other site.
4. Policy: `Include → Emails → your@email.com` (or whatever rule
   you already have set up).
5. Session duration: `24 hours`.
6. **After saving, copy the AUD tag** (Overview tab) into
   `wrangler.jsonc → vars.ACCESS_AUD`.
7. Copy your **Team subdomain** (the thing before
   `.cloudflareaccess.com`) into `vars.ACCESS_TEAM_DOMAIN`.

`/api/wod` (the public read) is **not** gated by Access — only
`/api/admin/*` paths.

### Custom domain

Once the Worker is deployed, attach `threetwone.com` in
**Workers & Pages → boxclock → Settings → Domains & Routes → Add
Custom Domain**. Cloudflare handles the TLS and the DNS CNAME for
you because the domain is already on the account.

### What gets verified

The Worker double-checks `Cf-Access-Jwt-Assertion` on every admin
request:

- `alg === RS256` and `kid` is present
- signature verifies against the team JWKS
- `aud` contains `ACCESS_AUD`
- `iss === https://<ACCESS_TEAM_DOMAIN>.cloudflareaccess.com`
- `exp` is in the future

If Access is ever misconfigured and stops enforcing the policy, the
Worker still rejects the request. Fail-closed.

### Deploying manually

```
npx wrangler versions upload      # preview (feature branches)
npx wrangler deploy               # production (main)
```

---

## Design notes

- **Timer ticks at 100ms using `performance.now()`** rather than
  `setInterval`. This eliminates drift on long AMRAPs and lets
  pause/resume preserve sub-second precision.
- **Segment-kind accents** (work = red, rest = green, station =
  blue) are driven by a CSS custom property so transitions are
  smooth instead of jumpy.
- **TV overscan:** all content sits inside a 5vh / 5vw safe-area
  padding so nothing hides behind the bezel on older TVs.
- **Focus rings are loud and yellow** on purpose — this is the
  only way a TV-remote user can see what's selected.

## State persistence

Per browser (`localStorage`):

- `boxclock.presetParams` — last-used params per preset
- `boxclock.muted` — mute state
- `boxclock.pastedToday` — visitor's ad-hoc workout override for
  today (cleared on date rollover, never shared)

Global (Cloudflare KV, `WOD` namespace):

- `wod:YYYY-MM-DD` → `{ title, description, timer? }` per owner-
  published day. Writable only through `/api/admin/wod` (gated by
  Access). Readable by anyone via `/api/wod?date=…`.

Clearing `localStorage` resets the visitor-side state. Clearing the
KV namespace removes every owner-published workout — use
`wrangler kv key delete --namespace-id=<id> wod:YYYY-MM-DD` for a
surgical delete.
