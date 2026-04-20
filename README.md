# boxclock

A static, single-page workout-of-the-day display with a configurable
CrossFit-style interval timer. Designed for two-screen use:

1. **Phone → Chromecast → TV.** Open `boxclock.pages.dev` on your
   phone and cast the tab.
2. **Smart TV browser.** Navigate with the remote's arrow keys and
   Enter — every control is a real focusable button.

No backend. No framework. No build step. Plain HTML + vanilla JS +
CSS. Double-click `index.html` to run locally; push to GitHub and
point Cloudflare Pages at the repo to deploy.

---

## File structure

```
/
├── index.html       # single page shell
├── app.js           # timer engine + UI + audio (all in one)
├── styles.css       # dark theme, TV-safe layout
├── workouts.json    # WODs keyed by YYYY-MM-DD
├── README.md        # this file
└── .gitignore
```

## Running locally

```
open index.html        # macOS
xdg-open index.html    # Linux
```

Some browsers block `fetch()` from `file://` URLs. If the seeded
workouts don't appear, serve the directory over HTTP:

```
python3 -m http.server 8000
# then visit http://localhost:8000
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

### Paste-box workflow

The control panel has a textarea for ad-hoc workouts:

- **Save for Today** stores the workout in `localStorage` under
  today's date (separate from `workouts.json`, so history is never
  overwritten). Used for the current session only.
- **Copy as JSON** puts a correctly-formatted
  `"YYYY-MM-DD": { ... }` snippet on the clipboard so you can
  paste it into `workouts.json` and commit it for permanence.

---

## Cloudflare Pages deployment

1. Push this repo to GitHub.
2. In the Cloudflare dashboard → **Workers & Pages** → **Create
   application** → **Pages** → **Connect to Git**.
3. Select the repo. For the build config:
   - **Framework preset:** None
   - **Build command:** *(leave blank)*
   - **Build output directory:** `/`
4. **Save and Deploy.** The first build publishes to a URL like
   `https://boxclock.pages.dev`. Every push to `main` auto-deploys.

No environment variables are needed. The site is fully static and
works offline after the first load (browser cache handles the
handful of files).

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

`localStorage` stores only:

- `boxclock.presetParams` — last-used params per preset
- `boxclock.muted` — mute state
- `boxclock.pastedToday` — today's ad-hoc workout (cleared on
  date rollover)

Clearing site data fully resets the app.
