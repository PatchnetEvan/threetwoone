// boxclock — static WOD display + CrossFit timer engine.
// No dependencies. One file. Split into three zones:
//   1. Timer engine (framework-agnostic, pure state)
//   2. Audio (Web Audio synth cues)
//   3. UI glue (DOM, config panel, workout data, persistence)

// ─────────────────────────────────────────────────────────────
// 1. TIMER ENGINE
// ─────────────────────────────────────────────────────────────
//
// One engine, six presets. Internal model:
//   direction:   "up" | "down"
//   totalCap:    optional cap in seconds (AMRAP, For Time cap)
//   segments:    optional [{ label, seconds, kind }]
//   rounds:      optional int, segments repeat this many times
//   restBetweenRounds: optional seconds inserted after each round
//
// The engine ticks at 100ms using performance.now() for drift-free
// accuracy. It exposes onTick(state) + onEvent({type, ...}) for UI.
// All pure state math — no DOM access in this section.

const TICK_MS = 100;
const PRE_START_SECS = 3; // "3, 2, 1, go"

class TimerEngine {
  constructor() {
    this.cfg = null;
    this.flat = [];       // flattened segment list incl. round rests
    this.status = "idle"; // idle | pre | running | paused | done
    this.segIndex = 0;
    this.segElapsed = 0;  // seconds inside current segment
    this.totalElapsed = 0;
    this.preCountdown = 0;
    this._lastTick = 0;
    this._rafId = null;
    this.onTick = () => {};
    this.onEvent = () => {};
  }

  // Flatten a config into a concrete ordered list of segments.
  // AMRAP/For Time/Stopwatch have no segments — they run against totalCap or
  // indefinitely. EMOM/Intervals/Circuit use explicit segment sequences that
  // repeat rounds times with optional rest between rounds.
  _flatten(cfg) {
    if (!cfg.segments || !cfg.segments.length) return [];
    const out = [];
    const rounds = Math.max(1, cfg.rounds || 1);
    for (let r = 0; r < rounds; r++) {
      for (const s of cfg.segments) {
        out.push({ ...s, round: r + 1, totalRounds: rounds });
      }
      if (cfg.restBetweenRounds && r < rounds - 1) {
        out.push({
          label: "Rest",
          seconds: cfg.restBetweenRounds,
          kind: "rest",
          round: r + 1,
          totalRounds: rounds,
        });
      }
    }
    return out;
  }

  load(cfg) {
    this.stop();
    this.cfg = cfg;
    this.flat = this._flatten(cfg);
    this.reset();
  }

  reset() {
    this.status = "idle";
    this.segIndex = 0;
    this.segElapsed = 0;
    this.totalElapsed = 0;
    this.preCountdown = 0;
    this._emit();
  }

  start() {
    if (this.status === "running" || this.status === "pre") return;
    if (this.status === "done") this.reset();
    // Pre-start countdown (beep, beep, beep, GO) for work/timed formats.
    // Stopwatch and For Time without cap skip pre-start since they just run.
    const skipPre = this.cfg.preset === "stopwatch";
    if (skipPre || this.status === "paused") {
      this.status = "running";
      this._lastTick = performance.now();
      this._loop();
      this.onEvent({ type: "start" });
    } else {
      this.status = "pre";
      this.preCountdown = PRE_START_SECS;
      this._lastTick = performance.now();
      this.onEvent({ type: "preStart", remaining: PRE_START_SECS });
      this._loop();
    }
    this._emit();
  }

  pause() {
    if (this.status !== "running" && this.status !== "pre") return;
    this.status = "paused";
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this.onEvent({ type: "pause" });
    this._emit();
  }

  stop() {
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this.status = "idle";
  }

  _loop = () => {
    const now = performance.now();
    const dt = (now - this._lastTick) / 1000; // seconds, sub-ms precision
    this._lastTick = now;

    if (this.status === "pre") {
      const prev = Math.ceil(this.preCountdown);
      this.preCountdown -= dt;
      const cur = Math.ceil(this.preCountdown);
      if (cur < prev && cur >= 1) {
        this.onEvent({ type: "preBeep", remaining: cur });
      }
      if (this.preCountdown <= 0) {
        this.status = "running";
        this.onEvent({ type: "go" });
      }
    } else if (this.status === "running") {
      this._advance(dt);
    }

    this._emit();
    if (this.status === "running" || this.status === "pre") {
      // Throttle to ~10Hz — good enough for display, cheaper than rAF-perframe.
      this._rafId = setTimeout(() => requestAnimationFrame(this._loop), TICK_MS);
    }
  };

  _advance(dt) {
    this.totalElapsed += dt;
    const cfg = this.cfg;

    // Cap-based finish (AMRAP/For Time with cap)
    if (cfg.totalCap && this.totalElapsed >= cfg.totalCap) {
      this.totalElapsed = cfg.totalCap;
      this._finish();
      return;
    }

    if (this.flat.length === 0) return; // open-ended (stopwatch / For Time no cap)

    const seg = this.flat[this.segIndex];
    const prevRemaining = Math.ceil(seg.seconds - this.segElapsed);
    this.segElapsed += dt;
    const remaining = seg.seconds - this.segElapsed;

    if (remaining <= 0) {
      const overflow = -remaining;
      const next = this.segIndex + 1;
      if (next >= this.flat.length) {
        this._finish();
        return;
      }
      const prev = seg;
      this.segIndex = next;
      this.segElapsed = overflow;
      const newSeg = this.flat[this.segIndex];
      const roundChanged = prev.round !== newSeg.round;
      this.onEvent({
        type: roundChanged ? "roundTransition" : "stationTransition",
        from: prev,
        to: newSeg,
      });
    } else {
      // Fire tick-down beeps on final 3 seconds of each segment
      const nowRemaining = Math.ceil(remaining);
      if (nowRemaining < prevRemaining && nowRemaining <= 3 && nowRemaining >= 1) {
        this.onEvent({ type: "segBeep", remaining: nowRemaining });
      }
    }
  }

  _finish() {
    this.status = "done";
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this.onEvent({ type: "complete" });
    this._emit();
  }

  // Snapshot for the UI.
  _emit() {
    const cfg = this.cfg || {};
    const seg = this.flat[this.segIndex];
    let displaySeconds, label, kind, roundText;

    if (this.status === "pre") {
      displaySeconds = Math.max(0, Math.ceil(this.preCountdown));
      label = "Get Ready";
      kind = "pre";
    } else if (this.status === "done") {
      // Show final elapsed or 00:00 depending on direction
      if (cfg.direction === "down" && cfg.totalCap) {
        displaySeconds = 0;
      } else {
        displaySeconds = Math.floor(this.totalElapsed);
      }
      label = "Done";
      kind = "done";
    } else if (seg) {
      displaySeconds = Math.max(0, Math.ceil(seg.seconds - this.segElapsed));
      label = seg.label;
      kind = seg.kind;
      roundText = `Round ${seg.round}/${seg.totalRounds}`;
    } else if (cfg.direction === "down" && cfg.totalCap) {
      displaySeconds = Math.max(0, Math.ceil(cfg.totalCap - this.totalElapsed));
      label = cfg.preset === "amrap" ? "AMRAP" : "Work";
      kind = "work";
    } else {
      // Stopwatch / For Time without cap
      displaySeconds = Math.floor(this.totalElapsed);
      label = cfg.preset === "forTime" ? "For Time" : "Stopwatch";
      kind = "work";
    }

    // While idle (loaded but not started), keep the neutral accent so
    // the timer doesn't read as "alarming red" before you press Start.
    if (this.status === "idle") kind = "idle";

    this.onTick({
      status: this.status,
      displaySeconds,
      label,
      kind,
      roundText,
      totalElapsed: this.totalElapsed,
    });
  }
}

// Build a normalized engine config from a preset + params.
function buildConfig(preset, p = {}) {
  switch (preset) {
    case "amrap":
      return { preset, direction: "down", totalCap: p.cap ?? 1200 };
    case "forTime":
      return { preset, direction: "up", totalCap: p.cap || null };
    case "emom": {
      const rounds = p.rounds ?? 10;
      const interval = p.interval ?? 60;
      return {
        preset,
        direction: "down",
        rounds,
        segments: [{ label: "Work", seconds: interval, kind: "work" }],
      };
    }
    case "intervals": {
      const rounds = p.rounds ?? 8;
      const work = p.work ?? 20;
      const rest = p.rest ?? 10;
      return {
        preset,
        direction: "down",
        rounds,
        segments: [
          { label: "Work", seconds: work, kind: "work" },
          { label: "Rest", seconds: rest, kind: "rest" },
        ],
      };
    }
    case "stopwatch":
      return { preset, direction: "up" };
    case "circuit": {
      const rounds = p.rounds ?? 3;
      const segments = (p.segments && p.segments.length ? p.segments : [
        { label: "Station 1", seconds: 60, kind: "station" },
      ]).map(s => ({ ...s, kind: s.kind || "station" }));
      return {
        preset,
        direction: "down",
        rounds,
        restBetweenRounds: p.restBetweenRounds ?? 0,
        segments,
      };
    }
    default:
      return { preset: "stopwatch", direction: "up" };
  }
}

// ─────────────────────────────────────────────────────────────
// 2. AUDIO (Web Audio synth)
// ─────────────────────────────────────────────────────────────
//
// All cues are synthesized at runtime — zero asset fetches.
// OscillatorNode → GainNode → destination, with exponential ramps
// on the gain envelope to eliminate the clicks you'd get from a
// bare oscillator stop(). Short beep = 880Hz / 120ms, long tone =
// 440Hz / 800ms. Countdown beeps rise in pitch toward the "go".

const Audio = {
  ctx: null,
  muted: false,

  _ensure() {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      this.ctx = new C();
    }
    // Mobile Chrome/Safari: resume on first user gesture
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },

  _tone(freq, durMs, { type = "sine", peak = 0.25 } = {}) {
    if (this.muted) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const dur = durMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // Envelope: fast attack (5ms), short hold, exponential release.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },

  shortBeep(freq = 880) { this._tone(freq, 120, { peak: 0.3 }); },
  longTone() { this._tone(440, 800, { type: "triangle", peak: 0.35 }); },

  doubleBeep() {
    this.shortBeep(880);
    setTimeout(() => this.shortBeep(880), 160);
  },

  countdownBeep(remaining) {
    // 3 → 660, 2 → 770, 1 → 880; makes the ramp-up audible
    const pitch = { 3: 660, 2: 770, 1: 880 }[remaining] || 880;
    this.shortBeep(pitch);
  },

  setMuted(m) {
    this.muted = !!m;
    localStorage.setItem("boxclock.muted", this.muted ? "1" : "0");
  },

  init() {
    this.muted = localStorage.getItem("boxclock.muted") === "1";
  },
};

// ─────────────────────────────────────────────────────────────
// 3. UI GLUE
// ─────────────────────────────────────────────────────────────

const $ = sel => document.querySelector(sel);
const fmt = s => {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
};
const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const shiftDate = (key, delta) => {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

// ── State
const state = {
  workouts: {},           // from workouts.json (seed/fallback)
  serverWorkouts: {},     // { "YYYY-MM-DD": entry } from KV via /api/wod
  currentDate: todayKey(),
  engine: new TimerEngine(),
  activePreset: "amrap",
  presetParams: {},       // persisted last-used params per preset
  pastedToday: null,      // { title, description } — local override
  isAdmin: false,         // true when ?admin=1 is in the URL
};

// ── Persistence
const LS = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
};

function loadPersisted() {
  state.presetParams = LS.get("boxclock.presetParams", {});
  const pasted = LS.get("boxclock.pastedToday", null);
  if (pasted && pasted.date === todayKey()) state.pastedToday = pasted;
}

function savePresetParams() { LS.set("boxclock.presetParams", state.presetParams); }

// ── Timer engine wiring
state.engine.onTick = snap => {
  $("#timer").textContent = fmt(snap.displaySeconds);
  $("#segment-label").textContent = snap.label || "Ready";
  const ri = $("#round-info");
  if (snap.roundText) { ri.textContent = snap.roundText; ri.hidden = false; }
  else ri.hidden = true;
  const app = $("#app");
  app.dataset.kind = snap.kind || "idle";
  app.dataset.warn = (snap.status === "running" && snap.displaySeconds <= 3 && snap.displaySeconds > 0) ? "true" : "false";
  $("#btn-start").disabled = snap.status === "running" || snap.status === "pre";
  $("#btn-pause").disabled = !(snap.status === "running" || snap.status === "pre");
  $("#btn-start").textContent = snap.status === "paused" ? "Resume" : snap.status === "done" ? "Start" : "Start";
};

state.engine.onEvent = ev => {
  switch (ev.type) {
    case "preBeep":  Audio.countdownBeep(ev.remaining); break;
    case "go":       Audio.longTone(); break;
    case "segBeep":  Audio.countdownBeep(ev.remaining); break;
    // Hybrid transition audio: station→station stays a single short beep so
    // you can hear "keep going, just a new station." Round boundaries and
    // workout completion get the long tone — same emphatic cue as the
    // pre-start "go" — because those are the moments you actually care
    // about without looking at the screen.
    case "stationTransition": Audio.shortBeep(); break;
    case "roundTransition":   Audio.longTone(); break;
    case "complete": Audio.longTone(); break;
  }
};

// ── Workout rendering
// Render priority per date, highest to lowest:
//   1. Local paste-box override (today only, localStorage)
//   2. Server-published WOD from KV (state.serverWorkouts[key])
//   3. Seeded workouts.json (state.workouts[key])
//   4. Empty state
function renderWorkout() {
  const key = state.currentDate;
  const fromPaste = (key === todayKey() && state.pastedToday) ? state.pastedToday : null;
  const fromServer = state.serverWorkouts[key] || null;
  const entry = fromPaste || fromServer || state.workouts[key] || null;

  $("#workout-date").textContent = key === todayKey() ? `Today — ${key}` : key;

  if (entry) {
    $("#workout-title").textContent = entry.title || "Untitled";
    $("#workout-body").textContent = entry.description || "";
    if (entry.timer && !fromPaste) applyTimer(entry.timer);
  } else {
    $("#workout-title").textContent = "No workout for this day";
    $("#workout-body").textContent = "Paste your own below, or use ◀ / ▶ to browse history.";
  }
}

// Fetch the server-published workout for a date and swap it into the
// render if present. Silent on network failure — the workouts.json
// fallback stays on screen.
async function fetchServerWorkout(date) {
  try {
    const res = await fetch(`/api/wod?date=${date}`, { cache: "no-store" });
    if (res.status === 404) { delete state.serverWorkouts[date]; return; }
    if (!res.ok) return;
    const entry = await res.json();
    state.serverWorkouts[date] = entry;
  } catch {
    // Network hiccup / offline — leave whatever we have cached in memory.
  }
}

function applyTimer(timer) {
  const preset = timer.preset;
  state.activePreset = preset;
  state.presetParams[preset] = { ...(state.presetParams[preset] || {}), ...timer };
  const cfg = buildConfig(preset, timer);
  state.engine.load(cfg);
}

// ── Controls
$("#btn-start").addEventListener("click", () => {
  Audio._ensure(); // prime on user gesture
  if (!state.engine.cfg) applyTimer({ preset: state.activePreset, ...(state.presetParams[state.activePreset] || {}) });
  state.engine.start();
});
$("#btn-pause").addEventListener("click", () => state.engine.pause());
$("#btn-reset").addEventListener("click", () => state.engine.reset());
$("#btn-config").addEventListener("click", openConfig);
$("#btn-mute").addEventListener("click", toggleMute);

async function gotoDate(date) {
  state.currentDate = date;
  renderWorkout();
  await fetchServerWorkout(date);
  renderWorkout();
}
$("#btn-prev").addEventListener("click", () => gotoDate(shiftDate(state.currentDate, -1)));
$("#btn-next").addEventListener("click", () => gotoDate(shiftDate(state.currentDate, +1)));
$("#btn-today").addEventListener("click", () => gotoDate(todayKey()));

// ── Paste box
$("#btn-paste-save").addEventListener("click", () => {
  const raw = $("#paste-box").value.trim();
  if (!raw) return;
  const [first, ...rest] = raw.split("\n");
  const entry = { title: first.trim() || "Workout", description: rest.join("\n").trim(), date: todayKey() };
  state.pastedToday = entry;
  LS.set("boxclock.pastedToday", entry);
  state.currentDate = todayKey();
  renderWorkout();
});

$("#btn-paste-copy").addEventListener("click", async () => {
  const raw = $("#paste-box").value.trim();
  if (!raw) return;
  const [first, ...rest] = raw.split("\n");
  const snippet = JSON.stringify({
    [todayKey()]: { title: first.trim(), description: rest.join("\n").trim() },
  }, null, 2);
  try {
    await navigator.clipboard.writeText(snippet);
    $("#btn-paste-copy").textContent = "Copied!";
    setTimeout(() => $("#btn-paste-copy").textContent = "Copy as JSON", 1500);
  } catch {
    // Fallback: put the snippet into the textarea
    $("#paste-box").value = snippet;
  }
});

$("#btn-paste-clear").addEventListener("click", () => {
  $("#paste-box").value = "";
  state.pastedToday = null;
  localStorage.removeItem("boxclock.pastedToday");
  renderWorkout();
});

// ── Mute
function toggleMute() {
  Audio.setMuted(!Audio.muted);
  $("#btn-mute").textContent = Audio.muted ? "Sound Off" : "Sound On";
  $("#btn-mute").setAttribute("aria-pressed", String(Audio.muted));
}

// ── Config panel
const CONFIG_FIELDS = {
  amrap: [{ key: "cap", label: "Cap (seconds)", type: "number", default: 1200 }],
  forTime: [{ key: "cap", label: "Cap (seconds, 0 = no cap)", type: "number", default: 0 }],
  emom: [
    { key: "rounds", label: "Rounds", type: "number", default: 10 },
    { key: "interval", label: "Every N seconds (60/120/180)", type: "number", default: 60 },
  ],
  intervals: [
    { key: "rounds", label: "Rounds", type: "number", default: 8 },
    { key: "work", label: "Work (seconds)", type: "number", default: 20 },
    { key: "rest", label: "Rest (seconds)", type: "number", default: 10 },
  ],
  stopwatch: [],
  circuit: [
    { key: "rounds", label: "Rounds", type: "number", default: 3 },
    { key: "restBetweenRounds", label: "Rest between rounds (seconds)", type: "number", default: 60 },
  ],
};

let configDraft = null;

function openConfig() {
  const preset = state.activePreset;
  configDraft = JSON.parse(JSON.stringify(state.presetParams[preset] || {}));
  renderConfigFields(preset);
  highlightPreset(preset);
  $("#config-dialog").showModal();
}

function highlightPreset(preset) {
  document.querySelectorAll(".preset-btn").forEach(b => {
    b.setAttribute("aria-selected", String(b.dataset.preset === preset));
  });
}

function renderConfigFields(preset) {
  state.activePreset = preset;
  const host = $("#config-fields");
  host.innerHTML = "";
  const fields = CONFIG_FIELDS[preset] || [];

  for (const f of fields) {
    const val = configDraft[f.key] ?? f.default;
    const lbl = document.createElement("label");
    const input = document.createElement("input");
    input.type = f.type;
    input.value = val;
    input.addEventListener("input", () => { configDraft[f.key] = Number(input.value); updateHints(); });
    lbl.append(document.createTextNode(f.label + " "));
    lbl.append(input);
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.dataset.for = f.key;
    lbl.append(hint);
    host.append(lbl);
  }

  // Presets with extras:
  if (preset === "intervals") {
    const tabata = document.createElement("button");
    tabata.type = "button";
    tabata.className = "btn btn-sm";
    tabata.textContent = "Tabata (20/10 × 8)";
    tabata.addEventListener("click", () => {
      configDraft = { rounds: 8, work: 20, rest: 10 };
      renderConfigFields("intervals");
    });
    host.append(tabata);
  }

  if (preset === "circuit") {
    const stationsHost = document.createElement("div");
    stationsHost.className = "stations-list";
    const list = (configDraft.segments || [
      { label: "Station 1", seconds: 60, kind: "station" },
    ]).map(s => ({ ...s }));
    configDraft.segments = list;

    const repaint = () => {
      stationsHost.innerHTML = "";
      list.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "station-row";
        const nameIn = document.createElement("input");
        nameIn.type = "text";
        nameIn.value = s.label;
        nameIn.addEventListener("input", () => s.label = nameIn.value);
        const secIn = document.createElement("input");
        secIn.type = "number";
        secIn.value = s.seconds;
        secIn.addEventListener("input", () => s.seconds = Number(secIn.value));
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "btn btn-sm";
        rm.textContent = "–";
        rm.addEventListener("click", () => { list.splice(i, 1); repaint(); });
        const actions = document.createElement("div");
        actions.className = "station-actions";
        actions.append(rm);
        row.append(nameIn, secIn, actions);
        stationsHost.append(row);
      });
    };

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-sm";
    addBtn.textContent = "+ Add Station";
    addBtn.addEventListener("click", () => {
      list.push({ label: `Station ${list.length + 1}`, seconds: 60, kind: "station" });
      repaint();
    });

    const fgb = document.createElement("button");
    fgb.type = "button";
    fgb.className = "btn btn-sm";
    fgb.textContent = "Fight Gone Bad (5×60s, rest 60s, 3 rounds)";
    fgb.addEventListener("click", () => {
      configDraft = {
        rounds: 3,
        restBetweenRounds: 60,
        segments: [
          { label: "Wall Balls", seconds: 60, kind: "station" },
          { label: "SDHP", seconds: 60, kind: "station" },
          { label: "Box Jumps", seconds: 60, kind: "station" },
          { label: "Push Press", seconds: 60, kind: "station" },
          { label: "Row", seconds: 60, kind: "station" },
        ],
      };
      renderConfigFields("circuit");
    });

    const stationsLbl = document.createElement("div");
    stationsLbl.textContent = "Stations:";
    host.append(stationsLbl, stationsHost, addBtn, fgb);
    repaint();
  }

  updateHints();
}

function updateHints() {
  document.querySelectorAll(".hint[data-for]").forEach(h => {
    const key = h.dataset.for;
    const val = configDraft[key];
    if ((key === "cap" || key === "interval" || key === "work" || key === "rest" || key === "restBetweenRounds") && Number.isFinite(val)) {
      h.textContent = ` (${fmt(val)})`;
    } else h.textContent = "";
  });
}

document.querySelectorAll(".preset-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.preset;
    configDraft = JSON.parse(JSON.stringify(state.presetParams[preset] || {}));
    renderConfigFields(preset);
    highlightPreset(preset);
  });
});

$("#btn-config-save").addEventListener("click", () => {
  const preset = state.activePreset;
  state.presetParams[preset] = configDraft;
  savePresetParams();
  applyTimer({ preset, ...configDraft });
  $("#config-dialog").close();
});
$("#btn-config-cancel").addEventListener("click", () => $("#config-dialog").close());

// ── Keyboard / remote
document.addEventListener("keydown", e => {
  // Don't hijack keys while typing in the paste box or config inputs
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "textarea" || (tag === "input" && e.target.type !== "button");
  if (typing) return;

  switch (e.key) {
    case " ": case "Spacebar":
      e.preventDefault();
      Audio._ensure();
      if (state.engine.status === "running" || state.engine.status === "pre") state.engine.pause();
      else state.engine.start();
      break;
    case "r": case "R": state.engine.reset(); break;
    case "m": case "M": toggleMute(); break;
    case "ArrowLeft":
      if (!$("#config-dialog").open) gotoDate(shiftDate(state.currentDate, -1));
      break;
    case "ArrowRight":
      if (!$("#config-dialog").open) gotoDate(shiftDate(state.currentDate, +1));
      break;
    case "Escape":
      if ($("#config-dialog").open) $("#config-dialog").close();
      break;
    case "1": case "2": case "3": case "4": case "5": case "6": {
      const map = ["amrap", "forTime", "emom", "intervals", "stopwatch", "circuit"];
      const preset = map[Number(e.key) - 1];
      state.activePreset = preset;
      applyTimer({ preset, ...(state.presetParams[preset] || {}) });
      break;
    }
  }
});

// ── Admin (publish / unpublish via Cloudflare Access-gated Worker routes)
// Credentials are handled entirely by Access cookies; there is no bearer
// token in this file. If Access isn't configured, POST/DELETE return 401
// and we surface the error to the admin.

function setAdminStatus(msg, state = "") {
  const el = $("#admin-status");
  if (!el) return;
  el.textContent = msg;
  if (state) el.dataset.state = state;
  else delete el.dataset.state;
}

async function adminPublish() {
  const raw = $("#admin-box").value.trim();
  if (!raw) { setAdminStatus("Nothing to publish.", "err"); return; }
  const [first, ...rest] = raw.split("\n");
  const date = state.currentDate;
  setAdminStatus("Publishing…");
  try {
    const res = await fetch("/api/admin/wod", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        date,
        title: first.trim() || "Workout",
        description: rest.join("\n").trim(),
      }),
    });
    if (res.status === 401) { setAdminStatus("Not authorized. Log in via Access first.", "err"); return; }
    if (!res.ok) { setAdminStatus(`Failed: ${res.status}`, "err"); return; }
    const { entry } = await res.json();
    state.serverWorkouts[date] = entry;
    renderWorkout();
    setAdminStatus(`Published for ${date}.`, "ok");
  } catch (err) {
    // Keep the textarea populated so the admin can retry without retyping.
    setAdminStatus(`Network error: ${err.message || err}`, "err");
  }
}

async function adminDelete() {
  const date = state.currentDate;
  if (!confirm(`Unpublish the workout for ${date}?`)) return;
  setAdminStatus("Unpublishing…");
  try {
    const res = await fetch(`/api/admin/wod?date=${date}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.status === 401) { setAdminStatus("Not authorized.", "err"); return; }
    if (!res.ok) { setAdminStatus(`Failed: ${res.status}`, "err"); return; }
    delete state.serverWorkouts[date];
    renderWorkout();
    setAdminStatus(`Unpublished ${date}.`, "ok");
  } catch (err) {
    setAdminStatus(`Network error: ${err.message || err}`, "err");
  }
}

// ── Boot
async function boot() {
  Audio.init();
  loadPersisted();
  $("#btn-mute").textContent = Audio.muted ? "Sound Off" : "Sound On";
  $("#btn-mute").setAttribute("aria-pressed", String(Audio.muted));

  // Admin mode is scoped to the /admin path, which is Access-gated at
  // the edge. Unauthenticated visitors never reach this code — Access
  // redirects them to login first. The Worker also re-verifies the
  // JWT on every write, so even if the UI loaded somehow, publishing
  // without a valid Access session still 401s.
  state.isAdmin = location.pathname === "/admin" || location.pathname.startsWith("/admin/");
  if (state.isAdmin) {
    $("#admin-area").hidden = false;
    $("#admin-banner").hidden = false;
    $("#btn-admin-publish").addEventListener("click", adminPublish);
    $("#btn-admin-delete").addEventListener("click", adminDelete);
  }

  try {
    // Runs both from file:// (opened directly) and via http:// (static host).
    const res = await fetch("workouts.json", { cache: "no-store" });
    if (res.ok) state.workouts = await res.json();
  } catch {
    // file:// may block fetch on some browsers — app still works with paste box.
    state.workouts = {};
  }

  // First render uses workouts.json as the initial fallback so the page
  // isn't blank while we hit KV.
  renderWorkout();

  // Fetch today's server-published workout; swap it in if present.
  await fetchServerWorkout(todayKey());
  renderWorkout();

  // If today has no timer from the rendered entry, load the last-used preset.
  const todayEntry = state.serverWorkouts[todayKey()] || state.workouts[todayKey()];
  if (!todayEntry || !todayEntry.timer) {
    applyTimer({ preset: state.activePreset, ...(state.presetParams[state.activePreset] || {}) });
  }

  // Focus Start so the TV remote lands somewhere useful
  $("#btn-start").focus();
}

boot();
