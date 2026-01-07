import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Giardino delle Voci -- ToM minimale (e giocabile)
 * Single-file React demo: arena continua, risorse prendibili, tono narrativo.
 *
 * Idea: due agenti NON comunicano intenzioni; le inferiscono da traiettorie e orientamento.
 */

// ---------- Math helpers ----------
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};
const dist = (ax: number, ay: number, bx: number, by: number) => Math.sqrt(dist2(ax, ay, bx, by));
const normAngle = (a: number) => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};
const angleTo = (ax: number, ay: number, bx: number, by: number) => Math.atan2(by - ay, bx - ax);
const softmax = (arr: number[], temp = 1) => {
  const t = Math.max(1e-6, temp);
  const m = Math.max(...arr);
  const exps = arr.map((x) => Math.exp((x - m) / t));
  const s = exps.reduce((p, c) => p + c, 0) || 1;
  return exps.map((e) => e / s);
};

// Simple seeded RNG (Mulberry32)
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Simulation ----------
const DEFAULTS = {
  seed: 1337,
  width: 860,
  height: 520,
  dt: 1 / 30,

  // Ritmo narrativo: abbassi "simRate" per rendere la scena più leggibile.
  simRate: 0.55, // 0.2..1.5

  speed: 85, // px/sec (valore base, scalato da simRate)
  turnSpeed: 4.2, // rad/sec (valore base, scalato da simRate)

  fovDeg: 120,
  viewDist: 230,
  takeRadius: 18,

  beliefTemp: 0.55,
  tomStrength: 0.85,

  noisePos: 1.8,
  noiseAng: 0.05,

  conflictCost: 1.25,
  cooperationBonus: 0.35,

  bluffChance: 0.18,
  bluffDurationTicks: 26,

  storyRate: 0.65,

  autoPause: true,
  pauseSeconds: 0.85,

  trailSeconds: 2.4,
  pivotGlowSeconds: 1.2,

  pickupFxSeconds: 1.05,

  // Espressività personaggi (cartoon)
  agentRadius: 34,
  eyeWhiteR: 12.6,
  pupilR: 4.4,
  gazePupilOffset: 5.2,
  blinkMinSec: 2.0,
  blinkMaxSec: 5.0,
  blinkDurationSec: 0.14,

  // Micro-saccadi
  saccadeMinSec: 0.35,
  saccadeMaxSec: 1.25,
  saccadeDurationSec: 0.07,
  saccadeAmp: 0.9,

  // Sguardi sociali (per farli "guardare" spesso)
  glanceChancePerSec: 0.55,
  glanceDurationSec: 0.55,

  // Cartoon motion
  squashDurationSec: 0.18,
  squashAmp: 0.22,

  soundOn: false,
};

type ResourceTypeId = "seme_blu" | "seme_ambra" | "seme_verde";

const RESOURCE_TYPES: Array<{ id: ResourceTypeId; name: string; glyph: string; color: string }> = [
  { id: "seme_blu", name: "Seme Blu", glyph: "*", color: "#60A5FA" },
  { id: "seme_ambra", name: "Seme Ambra", glyph: "+", color: "#FBBF24" },
  { id: "seme_verde", name: "Seme Verde", glyph: "#", color: "#34D399" },
];

type Resource = {
  id: string;
  typeId: ResourceTypeId;
  name: string;
  glyph: string;
  x: number;
  y: number;
  takenBy: null | "A" | "B";
};

type Agent = {
  id: "A" | "B";
  name: string;
  x: number;
  y: number;
  theta: number;
  vx: number;
  vy: number;
  carried: ResourceTypeId[];
  goal: string | null;
  beliefOther: Record<string, number>;
  memOther: Array<{ x: number; y: number; theta: number }>;
  bluffTicks: number;
  bluffTarget: string | null;
  preferences: Record<ResourceTypeId, number>;
  mood: "curiosa" | "furba" | "soddisfatta";

  conflict: number;
  gazeOtherT: number;
  squashT: number;

  trail: Array<{ x: number; y: number; t: number; tag: null | "pivot" | "bluff" }>;
  pivotGlowT: number;

  blinkT: number;
  nextBlinkAt: number;

  saccadeT: number;
  nextSaccadeAt: number;
  saccadeX: number;
  saccadeY: number;
};

type Effect =
  | {
      type: "pickup";
      t0: number;
      dur: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      color: string;
      glyph: string;
    }
  | {
      type: "none";
      t0: number;
      dur: number;
    };

type Sim = {
  t: number;
  tick: number;
  pauseT: number;
  effects: Effect[];
  subtitle: string;
  subtitleT: number;
  rng: () => number;
  resources: Resource[];
  agents: { A: Agent; B: Agent };
  story: string[];
};

function resourceColor(typeId: ResourceTypeId) {
  return RESOURCE_TYPES.find((t) => t.id === typeId)?.color || "#F5F5F5";
}

function spawnResources(rng: () => number, w: number, h: number, n = 3): Resource[] {
  const res: Resource[] = [];
  const margin = 55;
  for (let i = 0; i < n; i++) {
    const t = RESOURCE_TYPES[i % RESOURCE_TYPES.length];
    res.push({
      id: `${t.id}_${i}`,
      typeId: t.id,
      name: t.name,
      glyph: t.glyph,
      x: margin + rng() * (w - margin * 2),
      y: margin + rng() * (h - margin * 2),
      takenBy: null,
    });
  }
  return res;
}

function inFov(ax: number, ay: number, aTheta: number, bx: number, by: number, fovRad: number, viewDist: number) {
  const d = dist(ax, ay, bx, by);
  if (d > viewDist) return false;
  const ang = angleTo(ax, ay, bx, by);
  const delta = Math.abs(normAngle(ang - aTheta));
  return delta <= fovRad / 2;
}

function makeAgent(args: { id: "A" | "B"; name: string; x: number; y: number; theta: number; preferences: Record<ResourceTypeId, number> }): Agent {
  const { id, name, x, y, theta, preferences } = args;
  return {
    id,
    name,
    x,
    y,
    theta,
    vx: 0,
    vy: 0,
    carried: [],
    goal: null,
    beliefOther: {},
    memOther: [],
    bluffTicks: 0,
    bluffTarget: null,
    preferences,
    mood: "curiosa",

    conflict: 0,
    gazeOtherT: 0,
    squashT: 0,

    trail: [],
    pivotGlowT: 0,

    blinkT: 0,
    nextBlinkAt: 0,

    saccadeT: 0,
    nextSaccadeAt: 0,
    saccadeX: 0,
    saccadeY: 0,
  };
}

function pickBestResourceId(agent: Agent, resources: Resource[]) {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const r of resources) {
    if (r.takenBy) continue;
    const w = agent.preferences[r.typeId] ?? 0.1;
    if (w > bestScore) {
      bestScore = w;
      best = r.id;
    }
  }
  return best;
}

function resourceById(resources: Resource[], rid: string | null) {
  if (!rid) return null;
  return resources.find((r) => r.id === rid) || null;
}

function initSim(cfg: typeof DEFAULTS): Sim {
  const rng = mulberry32(cfg.seed);
  const resources = spawnResources(rng, cfg.width, cfg.height, 3);

  const prefA: Record<ResourceTypeId, number> = { seme_blu: 1.0, seme_ambra: 0.55, seme_verde: 0.25 };
  const prefB: Record<ResourceTypeId, number> = { seme_blu: 0.35, seme_ambra: 0.9, seme_verde: 0.6 };

  const A = makeAgent({ id: "A", name: "Lina", x: 130, y: cfg.height * 0.55, theta: 0.1, preferences: prefA });
  const B = makeAgent({ id: "B", name: "Milo", x: cfg.width - 140, y: cfg.height * 0.45, theta: Math.PI - 0.2, preferences: prefB });

  A.nextBlinkAt = 1.2 + rng() * 2.5;
  B.nextBlinkAt = 1.2 + rng() * 2.5;
  A.nextSaccadeAt = 0.3 + rng() * 0.8;
  B.nextSaccadeAt = 0.3 + rng() * 0.8;

  // beliefs uniform
  const initBel: Record<string, number> = {};
  resources.forEach((r) => (initBel[r.id] = 1 / resources.length));
  A.beliefOther = { ...initBel };
  B.beliefOther = { ...initBel };

  A.goal = pickBestResourceId(A, resources);
  B.goal = pickBestResourceId(B, resources);

  return {
    t: 0,
    tick: 0,
    pauseT: 0,
    effects: [],
    subtitle: "",
    subtitleT: 0,
    rng,
    resources,
    agents: { A, B },
    story: [
      `Nel Giardino delle Voci, ${A.name} e ${B.name} si cercano con lo sguardo.`,
      `Tre semi brillano nell'aria: Blu, Ambra, Verde. Ognuno promette una storia diversa.`,
    ],
  };
}

function visibleObservation(cfg: typeof DEFAULTS, sim: Sim, observer: Agent, other: Agent) {
  const fovRad = (cfg.fovDeg * Math.PI) / 180;
  const sees = inFov(observer.x, observer.y, observer.theta, other.x, other.y, fovRad, cfg.viewDist);
  if (!sees) return null;
  const nx = (sim.rng() * 2 - 1) * cfg.noisePos;
  const ny = (sim.rng() * 2 - 1) * cfg.noisePos;
  const na = (sim.rng() * 2 - 1) * cfg.noiseAng;
  return { x: other.x + nx, y: other.y + ny, theta: other.theta + na };
}

function updateBeliefAboutGoal(cfg: typeof DEFAULTS, me: Agent, obs: { x: number; y: number; theta: number } | null, resources: Resource[]) {
  const mem = me.memOther;
  const prev = mem.length ? mem[mem.length - 1] : null;
  const cur = obs;
  if (!cur) return;

  const scores: number[] = [];
  const keys: string[] = [];
  for (const r of resources) {
    if (r.takenBy) continue;
    keys.push(r.id);

    const dNow = dist(cur.x, cur.y, r.x, r.y);
    const dPrev = prev ? dist(prev.x, prev.y, r.x, r.y) : dNow + 1;
    const toward = clamp(dPrev - dNow, -25, 25);

    const aToRes = angleTo(cur.x, cur.y, r.x, r.y);
    const align = 1 - clamp(Math.abs(normAngle(aToRes - cur.theta)) / Math.PI, 0, 1);

    const prox = 1 - clamp(dNow / cfg.viewDist, 0, 1);

    const s = 0.55 * toward + 0.35 * (align * 12) + 0.1 * (prox * 10);
    scores.push(s);
  }

  if (!keys.length) return;
  const probs = softmax(scores, cfg.beliefTemp);

  const updated: Record<string, number> = { ...me.beliefOther };
  const alpha = clamp(cfg.tomStrength, 0, 1);
  let sum = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const prevP = updated[k] ?? 0;
    const newP = lerp(prevP, probs[i], alpha);
    updated[k] = newP;
    sum += newP;
  }
  if (sum > 0) {
    for (const k of keys) updated[k] /= sum;
  }

  me.beliefOther = updated;
  me.memOther = [...mem.slice(-12), cur];
}

function mostLikelyBelief(me: Agent) {
  let best: string | null = null;
  let bestP = -1;
  for (const [k, p] of Object.entries(me.beliefOther)) {
    if (p > bestP) {
      bestP = p;
      best = k;
    }
  }
  return { rid: best, p: bestP };
}

function pickAction(cfg: typeof DEFAULTS, sim: Sim, me: Agent, other: Agent, resources: Resource[]) {
  if (me.bluffTicks > 0 && me.bluffTarget) {
    me.bluffTicks -= 1;
    return { type: "move_to" as const, targetId: me.bluffTarget };
  }

  const available = resources.filter((r) => !r.takenBy);
  if (!available.length) return { type: "idle" as const };

  const belief = mostLikelyBelief(me);
  const conflictLikely = !!(belief.rid && belief.rid === me.goal && belief.p > 0.58);
  if (conflictLikely && sim.rng() < cfg.bluffChance) {
    const decoys = available.filter((r) => r.id !== me.goal);
    if (decoys.length) {
      decoys.sort((a, b) => dist(me.x, me.y, a.x, a.y) - dist(me.x, me.y, b.x, b.y));
      me.bluffTarget = decoys[0].id;
      me.bluffTicks = cfg.bluffDurationTicks;
      me.mood = "furba";
      return { type: "move_to" as const, targetId: me.bluffTarget, bluff: true };
    }
  }

  me.mood = "curiosa";

  const scored = available.map((r) => {
    const w = me.preferences[r.typeId] ?? 0.1;
    const d = dist(me.x, me.y, r.x, r.y);
    const distCost = d / 260;

    const pOther = me.beliefOther[r.id] ?? 0;
    const conflict = pOther;

    const likelyOther = mostLikelyBelief(me).rid;
    const coop = likelyOther && likelyOther !== r.id ? cfg.cooperationBonus : 0;

    const otherCloser = dist(other.x, other.y, r.x, r.y) < d ? 0.12 : 0;

    const u = w - distCost - cfg.conflictCost * conflict - otherCloser + coop;
    return { r, u };
  });

  scored.sort((a, b) => b.u - a.u);
  const best = scored[0];
  const chosenId = best?.r?.id || available[0].id;

  me.goal = chosenId;
  return { type: "move_to" as const, targetId: chosenId };
}

function stepMovement(cfg: typeof DEFAULTS, agent: Agent, target: Resource | null, dt: number) {
  if (!target) {
    agent.vx = 0;
    agent.vy = 0;
    return;
  }

  const desired = angleTo(agent.x, agent.y, target.x, target.y);
  const delta = normAngle(desired - agent.theta);
  const maxTurn = cfg.turnSpeed * dt;
  agent.theta += clamp(delta, -maxTurn, maxTurn);

  const sp = cfg.speed;
  agent.vx = Math.cos(agent.theta) * sp;
  agent.vy = Math.sin(agent.theta) * sp;

  agent.x += agent.vx * dt;
  agent.y += agent.vy * dt;

  agent.x = clamp(agent.x, 16, cfg.width - 16);
  agent.y = clamp(agent.y, 16, cfg.height - 16);
}

function attemptTake(cfg: typeof DEFAULTS, agent: Agent, resources: Resource[]) {
  const target = resourceById(resources, agent.goal);
  if (!target || target.takenBy) return null;
  if (dist(agent.x, agent.y, target.x, target.y) <= cfg.takeRadius) {
    target.takenBy = agent.id;
    agent.carried.push(target.typeId);
    agent.goal = pickBestResourceId(agent, resources);
    agent.bluffTicks = 0;
    agent.bluffTarget = null;
    agent.mood = "soddisfatta";
    return target;
  }
  return null;
}

function narrativeBeat(cfg: typeof DEFAULTS, sim: Sim, me: Agent, other: Agent, tookResource: Resource | null) {
  const beats: string[] = [];
  const belief = mostLikelyBelief(me);
  const otherBelief = mostLikelyBelief(other);

  const chance = clamp(cfg.storyRate, 0, 1);

  if (tookResource) beats.push(`${me.name} raccoglie il ${tookResource.name}. La sua voce cambia colore.`);

  if (sim.rng() < 0.22 * chance) {
    if (belief.rid) {
      const r = resourceById(sim.resources, belief.rid);
      if (r && !r.takenBy) {
        const p = Math.round(belief.p * 100);
        beats.push(`${me.name} sospetta che ${other.name} voglia il ${r.name} (${p}%).`);
      }
    }
  }

  if (sim.rng() < 0.16 * chance) {
    const fovRad = (cfg.fovDeg * Math.PI) / 180;
    const sees = inFov(me.x, me.y, me.theta, other.x, other.y, fovRad, cfg.viewDist);
    if (sees) beats.push(`${me.name} incrocia lo sguardo di ${other.name} e trattiene il fiato.`);
  }

  if (sim.rng() < 0.12 * chance) {
    if (me.mood === "furba") beats.push(`${me.name} fa un passo verso un seme che forse non desidera davvero.`);
  }

  if (sim.rng() < 0.08 * chance) {
    if (otherBelief.rid && otherBelief.rid === me.goal) beats.push(`${me.name} sente che le intenzioni di ${other.name} sfiorano le sue.`);
  }

  return beats;
}

function spawnPickupEffect(cfg: typeof DEFAULTS, sim: Sim, res: Resource, agent: Agent) {
  sim.effects.push({
    type: "pickup",
    t0: sim.t,
    dur: cfg.pickupFxSeconds,
    x0: res.x,
    y0: res.y,
    x1: agent.x,
    y1: agent.y,
    color: resourceColor(res.typeId),
    glyph: res.glyph,
  });
}

function playPickupSound(audioCtx: AudioContext, res: Resource) {
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  const base = res.typeId === "seme_blu" ? 392 : res.typeId === "seme_ambra" ? 523.25 : 440;
  osc.type = "sine";
  osc.frequency.setValueAtTime(base, now);
  osc.frequency.exponentialRampToValueAtTime(base * 1.5, now + 0.08);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.2);
}

// ---------- UI / App ----------
export default function App() {
  const [cfg, setCfg] = useState(DEFAULTS);
  const [running, setRunning] = useState(true);
  const [showMind, setShowMind] = useState(true);
  const [seed, setSeed] = useState<number | string>(DEFAULTS.seed);
  const [err, setErr] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Sim | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const [audioReady, setAudioReady] = useState(false);

  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);

  const fovRad = useMemo(() => (cfg.fovDeg * Math.PI) / 180, [cfg.fovDeg]);

  const reset = (newSeed = seed) => {
    setErr(null);
    const nextCfg = { ...cfg, seed: Number(newSeed) || 0 };
    setCfg(nextCfg);
    simRef.current = initSim(nextCfg);
  };

  useEffect(() => {
    simRef.current = initSim(cfg);
    setErr(null);

    // init audio context lazily on first user gesture
    const handler = () => {
      if (!audioRef.current) {
        try {
          const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
          audioRef.current = AC ? new AC() : null;
          setAudioReady(!!audioRef.current);
        } catch {
          audioRef.current = null;
          setAudioReady(false);
        }
      }
    };

    window.addEventListener("pointerdown", handler, { once: true });
    return () => window.removeEventListener("pointerdown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const loop = (ts: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const sim = simRef.current;
      if (!sim) return;

      try {
        const last = lastTimeRef.current || ts;
        lastTimeRef.current = ts;
        const elapsed = Math.min(0.1, (ts - last) / 1000);

        const dtEff = cfg.dt * clamp(cfg.simRate, 0.2, 1.5);
        const steps = Math.max(1, Math.floor(elapsed / cfg.dt));

        for (let i = 0; i < steps; i++) {
          sim.subtitleT += dtEff;
          if (sim.pauseT > 0) {
            sim.pauseT = Math.max(0, sim.pauseT - dtEff);
            continue;
          }

          if (running) {
            sim.t += dtEff;
            sim.tick += 1;

            const A = sim.agents.A;
            const B = sim.agents.B;

            // conflitto percepito (0..1): probabilità che l'altro voglia il mio stesso obiettivo
            const aBel = mostLikelyBelief(A);
            const bBel = mostLikelyBelief(B);
            A.conflict = aBel.rid && A.goal && aBel.rid === A.goal ? clamp(aBel.p, 0, 1) : 0;
            B.conflict = bBel.rid && B.goal && bBel.rid === B.goal ? clamp(bBel.p, 0, 1) : 0;

            // sguardi sociali: se sono vicini, ogni tanto si "cercano" anche fuori dal FOV
            const dAB = dist(A.x, A.y, B.x, B.y);
            if (dAB < cfg.viewDist * 0.92) {
              if (sim.rng() < cfg.glanceChancePerSec * dtEff) A.gazeOtherT = cfg.glanceDurationSec;
              if (sim.rng() < cfg.glanceChancePerSec * dtEff) B.gazeOtherT = cfg.glanceDurationSec;
            }
            A.gazeOtherT = Math.max(0, A.gazeOtherT - dtEff);
            B.gazeOtherT = Math.max(0, B.gazeOtherT - dtEff);

            const obsB = visibleObservation(cfg, sim, A, B);
            const obsA = visibleObservation(cfg, sim, B, A);
            if (obsB) updateBeliefAboutGoal(cfg, A, obsB, sim.resources);
            if (obsA) updateBeliefAboutGoal(cfg, B, obsA, sim.resources);

            const prevGoalA = A.goal;
            const prevGoalB = B.goal;

            const actA = pickAction(cfg, sim, A, B, sim.resources);
            const actB = pickAction(cfg, sim, B, A, sim.resources);

            const pivotA = !!(prevGoalA && A.goal && prevGoalA !== A.goal);
            const pivotB = !!(prevGoalB && B.goal && prevGoalB !== B.goal);
            if (pivotA) A.pivotGlowT = cfg.pivotGlowSeconds;
            if (pivotB) B.pivotGlowT = cfg.pivotGlowSeconds;

            const targetA = actA.type === "move_to" ? resourceById(sim.resources, actA.targetId) : null;
            const targetB = actB.type === "move_to" ? resourceById(sim.resources, actB.targetId) : null;

            stepMovement(cfg, A, targetA, dtEff);
            stepMovement(cfg, B, targetB, dtEff);

            A.trail.push({ x: A.x, y: A.y, t: sim.t, tag: (actA as any)?.bluff ? "bluff" : pivotA ? "pivot" : null });
            B.trail.push({ x: B.x, y: B.y, t: sim.t, tag: (actB as any)?.bluff ? "bluff" : pivotB ? "pivot" : null });
            const keepSince = sim.t - cfg.trailSeconds;
            A.trail = A.trail.filter((p) => p.t >= keepSince);
            B.trail = B.trail.filter((p) => p.t >= keepSince);

            A.pivotGlowT = Math.max(0, A.pivotGlowT - dtEff);
            B.pivotGlowT = Math.max(0, B.pivotGlowT - dtEff);

            for (const ag of [A, B]) {
              // blink
              ag.blinkT = Math.max(0, ag.blinkT - dtEff);
              if (sim.t >= ag.nextBlinkAt && ag.blinkT <= 0) {
                ag.blinkT = cfg.blinkDurationSec;
                ag.nextBlinkAt = sim.t + cfg.blinkMinSec + sim.rng() * (cfg.blinkMaxSec - cfg.blinkMinSec);
              }

              // micro-saccadi
              ag.saccadeT = Math.max(0, ag.saccadeT - dtEff);
              if (sim.t >= ag.nextSaccadeAt && ag.saccadeT <= 0) {
                ag.saccadeT = cfg.saccadeDurationSec;
                ag.nextSaccadeAt = sim.t + cfg.saccadeMinSec + sim.rng() * (cfg.saccadeMaxSec - cfg.saccadeMinSec);
                const ang = sim.rng() * Math.PI * 2;
                const amp = cfg.saccadeAmp * (0.65 + 0.7 * sim.rng());
                ag.saccadeX = Math.cos(ang) * amp;
                ag.saccadeY = Math.sin(ang) * amp;
              }

              // squash decay
              ag.squashT = Math.max(0, ag.squashT - dtEff);
            }

            const tookA = attemptTake(cfg, A, sim.resources);
            const tookB = attemptTake(cfg, B, sim.resources);

            if (tookA) {
              A.squashT = cfg.squashDurationSec;
              A.gazeOtherT = Math.max(A.gazeOtherT, cfg.glanceDurationSec * 0.6);
              spawnPickupEffect(cfg, sim, tookA, A);
              if (cfg.soundOn && audioRef.current) playPickupSound(audioRef.current, tookA);
            }
            if (tookB) {
              B.squashT = cfg.squashDurationSec;
              B.gazeOtherT = Math.max(B.gazeOtherT, cfg.glanceDurationSec * 0.6);
              spawnPickupEffect(cfg, sim, tookB, B);
              if (cfg.soundOn && audioRef.current) playPickupSound(audioRef.current, tookB);
            }

            sim.effects = (sim.effects || []).filter((e) => sim.t - (e as any).t0 <= (e as any).dur + 0.2);

            if (cfg.autoPause) {
              if (tookA || tookB) sim.pauseT = Math.max(sim.pauseT, cfg.pauseSeconds);
              if ((actA as any)?.bluff || (actB as any)?.bluff) sim.pauseT = Math.max(sim.pauseT, cfg.pauseSeconds * 0.75);

              const seesAB = inFov(A.x, A.y, A.theta, B.x, B.y, fovRad, cfg.viewDist);
              const seesBA = inFov(B.x, B.y, B.theta, A.x, A.y, fovRad, cfg.viewDist);
              if (seesAB && seesBA && sim.rng() < 0.08) sim.pauseT = Math.max(sim.pauseT, cfg.pauseSeconds * 0.6);
            }

            const narrEvery = Math.max(8, Math.round(14 / clamp(cfg.simRate, 0.2, 1.5)));
            if (sim.tick % narrEvery === 0) {
              const beats = [...narrativeBeat(cfg, sim, A, B, tookA), ...narrativeBeat(cfg, sim, B, A, tookB)];
              if (beats.length) {
                sim.story = [...sim.story, ...beats].slice(-28);
                sim.subtitle = beats[beats.length - 1];
                sim.subtitleT = 0;
              }
            }
          }
        }

        draw(ctx, cfg, sim, { fovRad, showMind });
      } catch (e: any) {
        console.error(e);
        setErr(e?.message ? String(e.message) : String(e));
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [cfg, running, showMind, fovRad]);

  const sim = simRef.current;

  const setNumClamped = (key: keyof typeof DEFAULTS, v: any, a: number, b: number) => {
    const val = clamp(Number(v), a, b);
    setCfg((c) => ({ ...c, [key]: val }));
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4">
      <div className="max-w-6xl mx-auto">
        <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <div className="text-2xl font-semibold tracking-tight">Giardino delle Voci</div>
            <div className="text-neutral-300 text-sm mt-1">Due agenti incarnati con teoria della mente minimale: inferiscono intenzioni da sguardo e traiettorie.</div>
            <div className="mt-3 text-sm text-neutral-300 leading-relaxed">
              <p className="mb-2">
                <b>Perché esiste questo esperimento?</b>
                <br />
                Il <i>Giardino delle Voci</i> nasce da una domanda semplice: <i>come fa un essere a capire cosa vuole un altro, senza parole?</i> Qui esploriamo una <b>Teoria della Mente minimale</b>: gli agenti non leggono la mente, ma osservano <b>movimenti, sguardi e traiettorie</b> e da questi costruiscono ipotesi sulle intenzioni altrui.
              </p>
              <p className="mb-2">
                <b>Cosa stai guardando?</b>
                <br />
                Due personaggi (Lina e Milo) si muovono in un giardino continuo. Ci sono tre semi diversi: ognuno ha un valore diverso per ciascun personaggio. Nessuna comunicazione esplicita è permessa: tutto ciò che accade nasce da <b>inferenza, esitazione, cooperazione e conflitto</b>.
              </p>
              <p>
                <b>Qual è lo scopo?</b>
                <br />
                Non vincere. Osservare. Cambiando i parametri puoi vedere emergere comportamenti diversi: attesa, turn-taking, bluff, sincronizzazione. È un esercizio per capire come <b>una mente minima può nascere dal comportamento</b>.
              </p>
            </div>
          </div>

          <div className="flex gap-2 items-center self-start md:self-end">
            <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition" onClick={() => setRunning((r) => !r)}>
              {running ? "Pausa" : "Avvia"}
            </button>
            <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition" onClick={() => reset(seed)}>
              Reset
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 transition"
              onClick={() => {
                const next = Math.floor(Math.random() * 999999);
                setSeed(next);
                reset(next);
              }}
            >
              Nuovo seme
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
          <div className="lg:col-span-2">
            <div className="rounded-2xl overflow-hidden border border-neutral-800 bg-neutral-900">
              <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800">
                <div className="text-sm text-neutral-300">Arena continua • Risorse prendibili • Narrativa emergente</div>
                <div className="flex items-center gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={showMind} onChange={(e) => setShowMind(e.target.checked)} />
                    <span className="text-neutral-300">Mostra mente</span>
                  </label>
                </div>
              </div>
              <div className="p-3">
                {err ? (
                  <div className="mb-3 rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                    <div className="font-medium">Errore runtime</div>
                    <div className="mt-1 font-mono text-xs break-all">{err}</div>
                    <div className="mt-2 text-xs text-red-200/80">Apri la console per lo stacktrace. Dopo una modifica, premi Reset.</div>
                  </div>
                ) : null}
                <canvas ref={canvasRef} width={cfg.width} height={cfg.height} className="w-full h-auto rounded-xl bg-neutral-950" />
              </div>
            </div>

            <div className="rounded-2xl border border-neutral-800 bg-neutral-900 mt-4 overflow-hidden">
              <div className="px-3 py-2 border-b border-neutral-800 flex items-center justify-between">
                <div className="text-sm text-neutral-300">Diario del Giardino</div>
                <div className="text-sm text-neutral-400">seed: {seed}</div>
              </div>
              <div className="p-3 max-h-[240px] overflow-auto">
                <ul className="space-y-2">
                  {(sim?.story || []).map((line, idx) => (
                    <li key={idx} className="text-sm text-neutral-200 leading-relaxed">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900 overflow-hidden">
              <div className="px-3 py-2 border-b border-neutral-800 text-sm text-neutral-300">Regia (parametri)</div>
              <div className="p-3 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <div className="text-neutral-300">Seed</div>
                    <input value={seed} onChange={(e) => setSeed(e.target.value)} className="mt-1 w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-neutral-100" />
                  </label>
                  <label className="text-sm">
                    <div className="text-neutral-300">Verbosità</div>
                    <input type="range" min={0} max={1} step={0.01} value={cfg.storyRate} onChange={(e) => setNumClamped("storyRate", e.target.value, 0, 1)} className="mt-3 w-full" />
                  </label>
                </div>

                <Param label="Theory-of-mind" value={cfg.tomStrength} min={0} max={1} step={0.01} onChange={(v) => setNumClamped("tomStrength", v, 0, 1)} />
                <Param label="Costo conflitto" value={cfg.conflictCost} min={0} max={2.5} step={0.01} onChange={(v) => setNumClamped("conflictCost", v, 0, 2.5)} />
                <Param label="Bonus cooperazione" value={cfg.cooperationBonus} min={0} max={1} step={0.01} onChange={(v) => setNumClamped("cooperationBonus", v, 0, 1)} />

                <Param label="Ritmo scena" value={cfg.simRate} min={0.2} max={1.5} step={0.01} onChange={(v) => setNumClamped("simRate", v, 0.2, 1.5)} />

                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={cfg.autoPause} onChange={(e) => setCfg((c) => ({ ...c, autoPause: e.target.checked }))} />
                  <span className="text-neutral-300">Micro-pause narrative</span>
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={cfg.soundOn} onChange={(e) => setCfg((c) => ({ ...c, soundOn: e.target.checked }))} />
                  <span className="text-neutral-300">Suono raccolta</span>
                  <span className="text-xs text-neutral-500">{audioReady ? "(pronto)" : "(tocchi lo schermo una volta per attivare)"}</span>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <Param label="FOV (°)" value={cfg.fovDeg} min={40} max={180} step={1} onChange={(v) => setNumClamped("fovDeg", v, 40, 180)} />
                  <Param label="Distanza vista" value={cfg.viewDist} min={120} max={360} step={1} onChange={(v) => setNumClamped("viewDist", v, 120, 360)} />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Param label="Rumore pos" value={cfg.noisePos} min={0} max={6} step={0.1} onChange={(v) => setNumClamped("noisePos", v, 0, 6)} />
                  <Param label="Rumore ang" value={cfg.noiseAng} min={0} max={0.25} step={0.005} onChange={(v) => setNumClamped("noiseAng", v, 0, 0.25)} />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Param label="Prob. bluff" value={cfg.bluffChance} min={0} max={0.6} step={0.01} onChange={(v) => setNumClamped("bluffChance", v, 0, 0.6)} />
                  <Param label="Durata bluff" value={cfg.bluffDurationTicks} min={0} max={70} step={1} onChange={(v) => setNumClamped("bluffDurationTicks", v, 0, 70)} />
                </div>

                <div className="pt-2 border-t border-neutral-800">
                  <div className="text-sm text-neutral-300">Note</div>
                  <div className="text-xs text-neutral-400 mt-1 leading-relaxed">
                    Suggerimenti: aumenti <b>Theory-of-mind</b> e rumore per far emergere esitazioni; alzi <b>Costo conflitto</b> per indurre turn-taking; aumenti <b>Prob. bluff</b> per vedere false intenzioni.
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-neutral-800 bg-neutral-900 overflow-hidden mt-4">
              <div className="px-3 py-2 border-b border-neutral-800 text-sm text-neutral-300">Stato rapido</div>
              <div className="p-3 space-y-3 text-sm">
                <QuickState sim={sim} />
              </div>
            </div>
          </div>
        </div>

        <footer className="mt-6 text-xs text-neutral-500">Questo prototipo mostra una ToM minimale: inferenza d'intenzione da movimento/orientamento, più regolazione strategica (cooperazione, conflitto, bluff).</footer>
      </div>
    </div>
  );
}

function Param(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: any) => void }) {
  const { label, value, min, max, step, onChange } = props;
  return (
    <label className="block text-sm">
      <div className="flex items-center justify-between">
        <span className="text-neutral-300">{label}</span>
        <span className="text-neutral-400 tabular-nums">{typeof value === "number" ? value.toFixed(step < 1 ? 2 : 0) : String(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(e.target.value)} className="mt-2 w-full" />
    </label>
  );
}

function QuickState({ sim }: { sim: Sim | null }) {
  if (!sim) return <div className="text-neutral-400">--</div>;
  const { A, B } = sim.agents;

  const fmtBel = (agent: Agent) => {
    const entries = Object.entries(agent.beliefOther)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    return entries
      .map(([rid, p]) => {
        const r = sim.resources.find((x) => x.id === rid);
        if (!r || r.takenBy) return null;
        return `${r.name} ${Math.round(p * 100)}%`;
      })
      .filter(Boolean)
      .join(" · ");
  };

  const goalName = (agent: Agent) => {
    const r = sim.resources.find((x) => x.id === agent.goal);
    return r && !r.takenBy ? r.name : "--";
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-neutral-200 font-medium">{A.name}</div>
        <div className="text-neutral-400">Obiettivo: {goalName(A)} · Umore: {A.mood}</div>
        <div className="text-neutral-400">Ipotesi su {B.name}: {fmtBel(A) || "--"}</div>
      </div>
      <div>
        <div className="text-neutral-200 font-medium">{B.name}</div>
        <div className="text-neutral-400">Obiettivo: {goalName(B)} · Umore: {B.mood}</div>
        <div className="text-neutral-400">Ipotesi su {A.name}: {fmtBel(B) || "--"}</div>
      </div>
      <div className="text-neutral-400">Semi raccolti: {A.name} {A.carried.length} · {B.name} {B.carried.length}</div>
    </div>
  );
}

// ---------- Canvas drawing ----------
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Background: giardino illustrato (leggero, leggibile, senza flicker)
function drawGardenBackground(ctx: CanvasRenderingContext2D, cfg: typeof DEFAULTS, sim: Sim) {
  const W = cfg.width;
  const H = cfg.height;

  ctx.clearRect(0, 0, W, H);

  // prato: gradiente morbido (centro più chiaro, bordi più scuri)
  const g = ctx.createRadialGradient(W * 0.5, H * 0.55, 40, W * 0.5, H * 0.55, Math.max(W, H) * 0.75);
  g.addColorStop(0, "#1F7A4A");
  g.addColorStop(0.55, "#185E3B");
  g.addColorStop(1, "#103625");
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // texture: puntini/"grana" fissa in base a seed (no sfarfallio)
  const seed = (cfg.seed >>> 0) || 1;
  const hash = (n: number) => {
    let x = (n ^ seed) >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };

  ctx.save();
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 520; i++) {
    const x = hash(i * 11 + 3) * W;
    const y = hash(i * 17 + 9) * H;
    const r = 0.6 + hash(i * 23 + 7) * 1.2;
    ctx.fillStyle = i % 2 === 0 ? "#0F2E20" : "#2AAE67";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // "ombre di foglie" agli angoli (cornice morbida)
  const leafShadow = (cx: number, cy: number, rx: number, ry: number, rot: number) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#0B0B10";
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  leafShadow(W * 0.12, H * 0.18, 160, 90, -0.45);
  leafShadow(W * 0.88, H * 0.22, 170, 95, 0.55);
  leafShadow(W * 0.16, H * 0.86, 200, 110, 0.35);
  leafShadow(W * 0.86, H * 0.84, 210, 115, -0.25);

  // siepe/bordo: vignetta verde scura
  ctx.save();
  const vg = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.25, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // piccoli fiori statici
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = "#E5FFE8";
  ctx.lineWidth = 1;
  for (let i = 0; i < 24; i++) {
    const x = hash(900 + i * 37) * W;
    const y = hash(1200 + i * 41) * H;
    const s = 2 + hash(1600 + i * 13) * 2;
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.lineTo(x + s, y);
    ctx.moveTo(x, y - s);
    ctx.lineTo(x, y + s);
    ctx.stroke();
  }
  ctx.restore();

  // farfallina lenta
  const t = sim.t;
  const bx = W * 0.5 + Math.cos(t * 0.25) * (W * 0.32);
  const by = H * 0.28 + Math.sin(t * 0.33) * (H * 0.10);
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#FFF7ED";
  ctx.beginPath();
  ctx.ellipse(bx - 4, by, 4.5, 3, 0.6, 0, Math.PI * 2);
  ctx.ellipse(bx + 4, by, 4.5, 3, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, cfg: typeof DEFAULTS, sim: Sim, opts: { fovRad: number; showMind: boolean }) {
  const W = cfg.width;
  const H = cfg.height;

  drawGardenBackground(ctx, cfg, sim);
  drawTrails(ctx, cfg, sim);
  drawResources(ctx, cfg, sim);
  drawEffects(ctx, cfg, sim);
  drawAgents(ctx, cfg, sim, opts.fovRad);
  drawSubtitle(ctx, cfg, sim);
  if (opts.showMind) drawMindPanel(ctx, cfg, sim);

  // overlay leggero
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = "#0B0B10";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function drawTrails(ctx: CanvasRenderingContext2D, cfg: typeof DEFAULTS, sim: Sim) {
  ctx.save();
  const now = sim.t;
  const drawTrail = (a: Agent, color: string) => {
    const pts = a.trail;
    if (pts.length < 2) return;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const age = now - p1.t;
      const alpha = clamp(1 - age / cfg.trailSeconds, 0, 1);
      ctx.globalAlpha = 0.08 + 0.18 * alpha;
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();

      if (p1.tag) {
        ctx.globalAlpha = 0.18 * alpha;
        ctx.fillStyle = p1.tag === "bluff" ? "#FCA5A5" : "#FDE68A";
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  drawTrail(sim.agents.A, "#C4B5FD");
  drawTrail(sim.agents.B, "#7DD3FC");
  ctx.restore();
}

function drawResources(ctx: CanvasRenderingContext2D, _cfg: typeof DEFAULTS, sim: Sim) {
  for (const r of sim.resources) {
    if (r.takenBy) continue;
    const col = resourceColor(r.typeId);

    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(r.x, r.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.arc(r.x, r.y, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.92;
    ctx.fillStyle = col;
    ctx.font = "16px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(r.glyph, r.x, r.y + 0.5);
    ctx.restore();
  }
}

function drawEffects(ctx: CanvasRenderingContext2D, _cfg: typeof DEFAULTS, sim: Sim) {
  const now = sim.t;
  for (const e of sim.effects || []) {
    if (e.type !== "pickup") continue;
    const t = clamp((now - e.t0) / e.dur, 0, 1);
    const ease = t * (2 - t);
    const x = lerp(e.x0, e.x1, ease);
    const y = lerp(e.y0, e.y1, ease);

    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.85;
    ctx.fillStyle = e.color;
    ctx.beginPath();
    ctx.arc(x, y, 10 + 10 * (1 - t), 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = (1 - t) * 0.95;
    ctx.fillStyle = "#FFF";
    ctx.font = "18px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(e.glyph, x, y);
    ctx.restore();
  }
}

function drawAgents(ctx: CanvasRenderingContext2D, cfg: typeof DEFAULTS, sim: Sim, fovRad: number) {
  drawOneAgent(ctx, cfg, sim, sim.agents.A, sim.agents.B, fovRad);
  drawOneAgent(ctx, cfg, sim, sim.agents.B, sim.agents.A, fovRad);
}

function drawOneAgent(ctx: CanvasRenderingContext2D, cfg: typeof DEFAULTS, sim: Sim, a: Agent, other: Agent, fovRad: number) {
  const r = cfg.agentRadius;

  const squash = a.squashT > 0 ? cfg.squashAmp * (a.squashT / cfg.squashDurationSec) : 0;
  const sx = 1 + squash;
  const sy = 1 - squash;

  // target sguardo
  let gx = a.x + Math.cos(a.theta) * 40;
  let gy = a.y + Math.sin(a.theta) * 40;
  if (a.gazeOtherT > 0) {
    gx = other.x;
    gy = other.y;
  } else {
    const g = resourceById(sim.resources, a.goal);
    if (g && !g.takenBy) {
      gx = g.x;
      gy = g.y;
    }
  }

  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(a.theta);
  ctx.scale(sx, sy);

  // glow pivot
  if (a.pivotGlowT > 0) {
    ctx.save();
    ctx.globalAlpha = 0.16 * (a.pivotGlowT / cfg.pivotGlowSeconds);
    ctx.fillStyle = a.id === "A" ? "#C4B5FD" : "#7DD3FC";
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // corpo
  ctx.save();
  ctx.globalAlpha = 0.98;
  ctx.fillStyle = a.id === "A" ? "#A78BFA" : "#38BDF8";
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 0.16;
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(-r * 0.25, -r * 0.25, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // volto: bocca sempre sotto occhi, ma sguardo avanti
  const faceFlip = Math.cos(a.theta) < 0;
  ctx.save();
  if (faceFlip) ctx.scale(1, -1);

  const angTo = angleTo(a.x, a.y, gx, gy);
  const dAng = normAngle(angTo - a.theta);
  const gaze = clamp(dAng / (fovRad / 2), -1, 1);

  const eyeY = -r * 0.18;
  const eyeX = r * 0.28;

  const blink = a.blinkT > 0 ? 1 - clamp(a.blinkT / cfg.blinkDurationSec, 0, 1) : 0;
  const eyeH = cfg.eyeWhiteR * (1 - 0.78 * blink);

  const saccX = a.saccadeT > 0 ? a.saccadeX : 0;
  const saccY = a.saccadeT > 0 ? a.saccadeY : 0;

  // occhi
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "#FFF";
  ctx.beginPath();
  ctx.ellipse(-eyeX, eyeY, cfg.eyeWhiteR, eyeH, 0, 0, Math.PI * 2);
  ctx.ellipse(+eyeX, eyeY, cfg.eyeWhiteR, eyeH, 0, 0, Math.PI * 2);
  ctx.fill();

  const basePx = cfg.gazePupilOffset * gaze + saccX;
  const basePy = 1.6 + saccY;
  const py = faceFlip ? -basePy : basePy;

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#0B0B10";
  ctx.beginPath();
  ctx.arc(-eyeX + basePx, eyeY + py, cfg.pupilR, 0, Math.PI * 2);
  ctx.arc(+eyeX + basePx, eyeY + py, cfg.pupilR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // guance
  ctx.save();
  const blush = clamp(a.conflict * 0.85 + (a.mood === "soddisfatta" ? 0.25 : 0) + (a.mood === "furba" ? 0.12 : 0), 0, 1);
  ctx.globalAlpha = 0.06 + 0.18 * blush;
  ctx.fillStyle = "#FDB4BF";
  ctx.beginPath();
  ctx.ellipse(-r * 0.42, -r * 0.02, r * 0.18, r * 0.13, 0, 0, Math.PI * 2);
  ctx.ellipse(+r * 0.42, -r * 0.02, r * 0.18, r * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // bocca (cute, -20%, un po' più bassa)
  const mx = r * 0.18;
  const mouthScale = 0.8;
  const my = r * 0.30 + 3;

  ctx.save();
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(11,11,16,0.78)";

  const conflict = clamp(a.conflict, 0, 1);
  if (conflict > 0.55) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "rgba(11,11,16,0.18)";
    ctx.beginPath();
    ctx.ellipse(mx + 8, my + 2, 6.2 * mouthScale, 8.6 * mouthScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.ellipse(mx + 6.5, my - 0.5, 2.8 * mouthScale, 4.2 * mouthScale, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (a.mood === "soddisfatta") {
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(mx - 8 * mouthScale, my);
    ctx.quadraticCurveTo(mx + 10 * mouthScale, my + 10 * mouthScale, mx + 24 * mouthScale, my);
    ctx.stroke();
  } else if (a.mood === "furba") {
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(mx - 8 * mouthScale, my + 2 * mouthScale);
    ctx.quadraticCurveTo(mx + 9 * mouthScale, my - 10 * mouthScale, mx + 24 * mouthScale, my + 3 * mouthScale);
    ctx.stroke();
  } else {
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(mx - 8 * mouthScale, my);
    ctx.quadraticCurveTo(mx + 9 * mouthScale, my - 3 * mouthScale, mx + 24 * mouthScale, my);
    ctx.stroke();
  }
  ctx.restore();

  ctx.restore(); // flip faccia

  // nome: annulla rotazione corpo
  ctx.save();
  ctx.rotate(-a.theta);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#D4D4E1";
  ctx.font = "12px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(a.name, 0, -r - 12);

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = a.id === "A" ? "#A78BFA" : "#38BDF8";
  ctx.beginPath();
  ctx.arc(-22, -r - 16, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore(); // corpo
}

function drawSubtitle(ctx: CanvasRenderingContext2D, cfg: typeof DEFAULTS, sim: Sim) {
  if (!sim.subtitle) return;
  const t = sim.subtitleT;
  if (t > 2.8) return;

  ctx.save();
  const W = cfg.width;
  const H = cfg.height;
  const alpha = clamp(1 - t / 2.8, 0, 1);
  ctx.globalAlpha = 0.22 + 0.55 * alpha;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, W * 0.08, H - 58, W * 0.84, 44, 14);
  ctx.fill();

  ctx.globalAlpha = 0.88 * alpha;
  ctx.fillStyle = "#F5F5F5";
  ctx.font = "14px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(sim.subtitle, W * 0.5, H - 36);
  ctx.restore();
}

function drawMindPanel(ctx: CanvasRenderingContext2D, cfg: typeof DEFAULTS, sim: Sim) {
  const W = cfg.width;
  const pad = 14;
  const boxW = 250;
  const boxH = 86;

  const panel = (x: number, y: number, a: Agent, other: Agent) => {
    const bel = mostLikelyBelief(a);
    const r = bel.rid ? sim.resources.find((rr) => rr.id === bel.rid) : null;

    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    roundRect(ctx, x, y, boxW, boxH, 16);
    ctx.fill();

    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "#E5E7EB";
    ctx.font = "12px ui-sans-serif, system-ui";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`${a.name} ipotizza`, x + 12, y + 10);

    const line = r && !r.takenBy ? `${other.name} -> ${r.name} (${Math.round(bel.p * 100)}%)` : `${other.name} -> ?`;
    ctx.globalAlpha = 0.9;
    ctx.fillText(line, x + 12, y + 30);

    const entries = Object.entries(a.beliefOther)
      .map(([rid, p]) => ({ rid, p }))
      .sort((u, v) => v.p - u.p)
      .slice(0, 3);

    const barX = x + 12;
    const barY = y + 54;
    const barW = boxW - 24;
    const barH = 8;

    entries.forEach((it, i) => {
      const rr = sim.resources.find((q) => q.id === it.rid);
      if (!rr || rr.takenBy) return;
      const yy = barY + i * 12;
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      roundRect(ctx, barX, yy, barW, barH, 6);
      ctx.fill();

      ctx.globalAlpha = 0.75;
      ctx.fillStyle = resourceColor(rr.typeId);
      roundRect(ctx, barX, yy, barW * clamp(it.p, 0, 1), barH, 6);
      ctx.fill();
    });

    ctx.restore();
  };

  panel(pad, pad, sim.agents.A, sim.agents.B);
  panel(W - pad - boxW, pad, sim.agents.B, sim.agents.A);
}
