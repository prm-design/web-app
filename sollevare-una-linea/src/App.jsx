import React, { useMemo, useRef, useState } from "react";

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function sampleCurve({ base, zMode, turns, samples }) {
  // Parameter u in [0, 1]
  const pts3 = [];
  const pts2 = [];
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    let x = 0,
      y = 0;

    if (base === "line") {
      x = -1 + 2 * u;
      y = 0.3;
    } else if (base === "circle") {
      const ang = 2 * Math.PI * u;
      x = Math.cos(ang);
      y = Math.sin(ang);
    } else if (base === "sine") {
      x = -1 + 2 * u;
      y = 0.6 * Math.sin(2 * Math.PI * u);
    } else if (base === "lissajous") {
      const ang = 2 * Math.PI * u;
      x = Math.sin(2 * ang);
      y = Math.sin(3 * ang);
    }

    // z depends on chosen lift; allow extra turns for a "spiral" feel
    const t = turns * 2 * Math.PI * u; // cumulative angle-like parameter
    let z = 0;
    if (zMode === "flat") z = 0;
    if (zMode === "ramp") z = (t / (2 * Math.PI)) * 0.35;
    if (zMode === "sin") z = 0.35 * Math.sin(t);
    if (zMode === "quad") {
      const v = u - 0.5;
      z = 1.2 * v * v;
    }

    pts2.push([x, y]);
    pts3.push([x, y, z]);
  }
  return { pts2, pts3 };
}

function fitToView2D(points, pad = 18) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  return { minX, minY, w, h, pad };
}

function Polyline2D({ points, highlightT, caption, onDragT }) {
  const W = 440;
  const H = 280;
  // reserve space for labels (top) and instruction (bottom)
  const topInset = 40;
  const bottomInset = onDragT ? 30 : 14;
  const box = fitToView2D(points);
  const usableH = H - topInset - bottomInset;
  const scale = Math.min((W - 2 * box.pad) / box.w, (usableH - 2 * box.pad) / box.h);
  const tx = (x) => (x - box.minX) * scale + box.pad;
  const ty = (y) => H - bottomInset - ((y - box.minY) * scale + box.pad);

  const d = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${tx(x).toFixed(2)} ${ty(y).toFixed(2)}`)
    .join(" ");

  const idx = clamp(Math.round(highlightT * (points.length - 1)), 0, points.length - 1);
  const [hx, hy] = points[idx];

  const handlePointer = (e) => {
    if (!onDragT) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const u = clamp(x / rect.width, 0, 1);
    onDragT(u);
  };

  const handlePointerDown = (e) => {
    handlePointer(e);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!onDragT) return;
    // Only drag when a button is pressed (mouse) or pointer is captured (touch)
    if (e.buttons === 0 && e.pointerType === "mouse") return;
    handlePointer(e);
  };

  const handlePointerUp = (e) => {
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`w-full h-full select-none ${onDragT ? "cursor-ew-resize" : "cursor-default"}`}
      style={{ touchAction: "none" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <rect x="0" y="0" width={W} height={H} rx="18" fill="#ffffff" />

      <path d={d} fill="none" stroke="#0f172a" strokeWidth="3" strokeLinecap="round" />
      <circle cx={tx(hx)} cy={ty(hy)} r="7" fill="#0f172a" />
      <text x="16" y="28" fill="#64748b" style={{ fontSize: 13 }}>
        {caption}
      </text>
      {onDragT ? (
        <text x="16" y={H - 12} fill="#94a3b8" style={{ fontSize: 12 }}>
          Trascini per spostare il punto (t)
        </text>
      ) : null}
    </svg>
  );
}

function rotateXYZ([x, y, z], yaw, pitch) {
  // yaw around Z, pitch around X (simple, stable for a demo)
  const cz = Math.cos(yaw);
  const sz = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);

  // Z rotation
  const x1 = cz * x - sz * y;
  const y1 = sz * x + cz * y;
  const z1 = z;

  // X rotation
  const y2 = cx * y1 - sx * z1;
  const z2 = sx * y1 + cx * z1;

  return [x1, y2, z2];
}

function projectTo2D([x, y, z]) {
  // A very lightweight "camera": perspective-ish with fixed coefficients
  const px = x + 0.55 * z;
  const py = y - 0.35 * z;
  return [px, py];
}

function Scene3DLightweight({ points3, t, yaw, pitch }) {
  // Convert 3D polyline to a 2D projected polyline (SVG)
  const projected = useMemo(() => {
    return points3.map((p) => {
      const r = rotateXYZ(p, yaw, pitch);
      const q = projectTo2D(r);
      return q;
    });
  }, [points3, yaw, pitch]);

  const W = 440;
  const H = 320;

  // Reserve space for the caption so the curve/marker never overlaps it
  const topInset = 40;
  const bottomInset = 14;

  const box = fitToView2D(projected, 22);
  const usableH = H - topInset - bottomInset;
  const scale = Math.min((W - 2 * box.pad) / box.w, (usableH - 2 * box.pad) / box.h);
  const tx = (x) => (x - box.minX) * scale + box.pad;
  const ty = (y) => H - bottomInset - ((y - box.minY) * scale + box.pad);

  const d = projected
    .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${tx(x).toFixed(2)} ${ty(y).toFixed(2)}`)
    .join(" ");

  const idx = clamp(Math.round(t * (points3.length - 1)), 0, points3.length - 1);
  const [mx, my] = projected[idx];

  // simple axes hint
  const origin = projectTo2D(rotateXYZ([0, 0, 0], yaw, pitch));
  const ax = projectTo2D(rotateXYZ([1.1, 0, 0], yaw, pitch));
  const ay = projectTo2D(rotateXYZ([0, 1.1, 0], yaw, pitch));
  const az = projectTo2D(rotateXYZ([0, 0, 1.1], yaw, pitch));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full select-none">
      <rect x="0" y="0" width={W} height={H} rx="18" fill="#ffffff" />

      {/* axes */}
      <line
        x1={tx(origin[0])}
        y1={ty(origin[1])}
        x2={tx(ax[0])}
        y2={ty(ax[1])}
        stroke="#e2e8f0"
        strokeWidth={3}
      />
      <line
        x1={tx(origin[0])}
        y1={ty(origin[1])}
        x2={tx(ay[0])}
        y2={ty(ay[1])}
        stroke="#e2e8f0"
        strokeWidth={3}
      />
      <line
        x1={tx(origin[0])}
        y1={ty(origin[1])}
        x2={tx(az[0])}
        y2={ty(az[1])}
        stroke="#e2e8f0"
        strokeWidth={3}
      />

      {/* curve */}
      <path d={d} fill="none" stroke="#0f172a" strokeWidth="3" strokeLinecap="round" />

      {/* marker */}
      <circle cx={tx(mx)} cy={ty(my)} r="6" fill="#0f172a" />

      <text x="16" y="28" fill="#64748b" style={{ fontSize: 13 }}>
        Vista 3D semplificata (proiezione + rotazione)
      </text>
    </svg>
  );
}

function GeometricLifting() {
  const [base, setBase] = useState("circle");
  const [zMode, setZMode] = useState("ramp");
  const [turns, setTurns] = useState(1);
  const [t, setT] = useState(0.15);
  const [yaw, setYaw] = useState(0.6);
  const [pitch, setPitch] = useState(0.45);

  const drag = useRef({ active: false, sx: 0, sy: 0, yaw0: 0, pitch0: 0 });

  const { pts2, pts3 } = useMemo(() => sampleCurve({ base, zMode, turns, samples: 260 }), [base, zMode, turns]);

  const onPointerDown = (e) => {
    // Start drag-to-orient on the 3D panel
    drag.current.active = true;
    drag.current.sx = e.clientX;
    drag.current.sy = e.clientY;
    drag.current.yaw0 = yaw;
    drag.current.pitch0 = pitch;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.sx;
    const dy = e.clientY - drag.current.sy;

    // Sensitivity tuned for the SVG viewport
    const s = 0.008;
    const nextYaw = drag.current.yaw0 + dx * s;
    const nextPitch = clamp(drag.current.pitch0 + dy * s, -1.57, 1.57);

    setYaw(nextYaw);
    setPitch(nextPitch);
  };

  const endDrag = (e) => {
    drag.current.active = false;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
        <div className="text-lg font-semibold text-slate-900">Sollevamento geometrico</div>
        <div className="text-sm text-slate-600 mt-1 leading-relaxed">
          Parto da una curva nel piano (l’ombra) e costruisco una curva nello spazio tale che la sua proiezione ortogonale
          sia identica alla curva di partenza. La componente <span className="font-medium">z(t)</span> è una scelta: è
          qui che vive la famiglia dei sollevamenti.
        </div>

        <div className="mt-4 grid gap-3">
          <div className="grid md:grid-cols-3 gap-3">
            <label className="text-sm">
              <div className="text-xs text-slate-600 font-medium">Curva di base</div>
              <select
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              >
                <option value="line">Retta</option>
                <option value="circle">Cerchio</option>
                <option value="sine">Sinusoide</option>
                <option value="lissajous">Lissajous</option>
              </select>
            </label>

            <label className="text-sm">
              <div className="text-xs text-slate-600 font-medium">Sollevamento z(t)</div>
              <select
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
                value={zMode}
                onChange={(e) => setZMode(e.target.value)}
              >
                <option value="flat">z(t)=0 (piano)</option>
                <option value="ramp">z(t)=t (rampa)</option>
                <option value="sin">z(t)=sin(t) (onda)</option>
                <option value="quad">z(t)=t² (parabola)</option>
              </select>
            </label>

            <label className="text-sm">
              <div className="text-xs text-slate-600 font-medium">Giri (per t)</div>
              <input
                type="range"
                min={1}
                max={6}
                step={1}
                value={turns}
                onChange={(e) => setTurns(parseInt(e.target.value, 10))}
                className="mt-2 w-full"
              />
              <div className="mt-1 text-slate-500">{turns}</div>
            </label>
          </div>

          <label className="text-sm">
            <div className="text-xs text-slate-600 font-medium">Parametro t (punto evidenziato)</div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={t}
              onChange={(e) => setT(parseFloat(e.target.value))}
              className="mt-2 w-full"
            />
          </label>

          <div className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-50 w-full aspect-[16/10] max-h-[320px]">
            <Polyline2D
              points={pts2}
              highlightT={t}
              caption="Proiezione ortogonale: π(x,y,z)=(x,y)"
              onDragT={(u) => setT(u)}
            />
          </div>

          <div className="text-sm text-slate-600 leading-relaxed">
            Nota: qui il sollevamento non è unico. La stessa curva proiettata può corrispondere a infiniti percorsi nello
            spazio, finché la coppia (x(t), y(t)) resta invariata.
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
        <div className="text-lg font-semibold text-slate-900">Curva sollevata (vista 3D leggera)</div>
        <div className="text-sm text-slate-600 mt-1 leading-relaxed">
          Per evitare dipendenze 3D nell’anteprima, questa vista usa una proiezione semplificata: ruotando i parametri,
          osservi come il tracciato cambi, mentre l’ombra (a sinistra) resta identica.
        </div>

        <div className="mt-4 grid gap-3">
          <label className="text-sm">
            <div className="text-xs text-slate-600 font-medium">Rotazione (yaw)</div>
            <input
              type="range"
              min={-3.14}
              max={3.14}
              step={0.01}
              value={yaw}
              onChange={(e) => setYaw(parseFloat(e.target.value))}
              className="mt-2 w-full"
            />
          </label>

          <label className="text-sm">
            <div className="text-xs text-slate-600 font-medium">Inclinazione (pitch)</div>
            <input
              type="range"
              min={-1.57}
              max={1.57}
              step={0.01}
              value={pitch}
              onChange={(e) => setPitch(parseFloat(e.target.value))}
              className="mt-2 w-full"
            />
          </label>

          <div
            className={`rounded-2xl border border-slate-200 overflow-hidden bg-slate-50 w-full aspect-[16/10] max-h-[360px] select-none ${
              drag.current.active ? "cursor-grabbing" : "cursor-grab"
            }`}
            style={{ touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={endDrag}
          >
            <Scene3DLightweight points3={pts3} t={t} yaw={yaw} pitch={pitch} />
          </div>

          <div className="text-sm text-slate-600 leading-relaxed">
            Il punto evidenziato corrisponde allo stesso valore di t mostrato nella proiezione.
          </div>
        </div>
      </div>
    </div>
  );
}

function CircleLiftViz({ turns, t, onChangeT }) {
  // Covering map p: R -> S1, p(θ) = (cos θ, sin θ)
  // Path on S1: γ(t) = (cos(2π·turns·t), sin(2π·turns·t))
  // Lift on R: γ̃(t) = 2π·turns·t (given γ̃(0)=0)

  const W = 640;
  const H = 280;
  const pad = 18;
  const cx = 160;
  const cy = 160;
  const r = 110;

  const theta0 = 0;
  const theta1 = 2 * Math.PI * turns;
  const thetaT = theta1 * t;

  const drag = useRef({ active: false, lastAng: 0, accumTheta: 0 });

  const ang = 2 * Math.PI * turns * t;
  const px = cx + r * Math.cos(ang);
  const py = cy + r * Math.sin(ang);

  const lineX0 = 360;
  const lineX1 = W - pad;
  const lineY = 160;

  const mapThetaToX = (th) => lineX0 + ((th - theta0) / (theta1 - theta0 || 1)) * (lineX1 - lineX0);

  const tx = mapThetaToX(thetaT);

  const tickCount = Math.max(2, turns * 2);
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const th = (theta1 * i) / tickCount;
    return { th, x: mapThetaToX(th) };
  });

  const getAngleFromEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Map screen coords into SVG viewBox coords
    const sx = (x / rect.width) * W;
    const sy = (y / rect.height) * H;

    return Math.atan2(sy - cy, sx - cx);
  };

  const wrapDelta = (d) => {
    // wrap to [-pi, pi]
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };

  const startDrag = (e) => {
    if (!onChangeT) return;
    const a = getAngleFromEvent(e);
    drag.current.active = true;
    drag.current.lastAng = a;
    drag.current.accumTheta = thetaT;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveDrag = (e) => {
    if (!onChangeT) return;
    if (!drag.current.active) return;
    if (e.buttons === 0 && e.pointerType === "mouse") return;

    const a = getAngleFromEvent(e);
    const da = wrapDelta(a - drag.current.lastAng);

    drag.current.accumTheta = clamp(drag.current.accumTheta + da, theta0, theta1);
    drag.current.lastAng = a;

    onChangeT(drag.current.accumTheta / theta1);
  };

  const endDrag = (e) => {
    drag.current.active = false;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
      <rect x="0" y="0" width={W} height={H} rx="18" fill="#ffffff" />

      <text x={pad} y={28} fill="#334155" style={{ fontSize: 14, fontWeight: 600 }}>
        Spazio base: S¹ (il cerchio)
      </text>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#0f172a" strokeWidth={3} />
      <line x1={cx} y1={cy} x2={px} y2={py} stroke="#cbd5e1" strokeWidth={3} />
      {/* hit area (bigger, transparent) + draggable point */}
      <circle
        cx={px}
        cy={py}
        r={18}
        fill="transparent"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <circle
        cx={px}
        cy={py}
        r={7}
        fill="#0f172a"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />

      <path
        d={`M ${cx + r + 24} ${cy} C ${cx + r + 90} ${cy - 50}, ${lineX0 - 90} ${cy - 50}, ${lineX0 - 24} ${cy}`}
        fill="none"
        stroke="#cbd5e1"
        strokeWidth={3}
      />
      <polygon
        points={`${lineX0 - 24},${cy} ${lineX0 - 38},${cy - 8} ${lineX0 - 38},${cy + 8}`}
        fill="#cbd5e1"
      />
      <text x={cx + r + 30} y={cy + 22} fill="#64748b" style={{ fontSize: 13 }}>
        p(θ) = (cos θ, sin θ)
      </text>

      <text x={lineX0} y={28} fill="#334155" style={{ fontSize: 14, fontWeight: 600 }}>
        Spazio sollevato: ℝ (l’angolo)
      </text>
      <line x1={lineX0} y1={lineY} x2={lineX1} y2={lineY} stroke="#0f172a" strokeWidth={3} />

      {ticks.map((tk, i) => (
        <g key={i}>
          <line x1={tk.x} y1={lineY - 10} x2={tk.x} y2={lineY + 10} stroke="#cbd5e1" strokeWidth={2} />
        </g>
      ))}

      <circle cx={tx} cy={lineY} r={7} fill="#0f172a" />

      <text x={lineX0} y={H - 18} fill="#475569" style={{ fontSize: 13 }}>
        Sollevamento con γ̃(0)=0: γ̃(t)=2π·{turns}·t  →  endpoint: {thetaT.toFixed(2)}
      </text>
      {typeof onChangeT !== "undefined" ? (
        <text x={pad} y={H - 18} fill="#94a3b8" style={{ fontSize: 12 }}>
          Trascini il punto sul cerchio per far scorrere t
        </text>
      ) : null}
    </svg>
  );
}

function TopologicalLifting() {
  const [turns, setTurns] = useState(1);
  const [t, setT] = useState(0.25);

  const ang = 2 * Math.PI * turns * t;
  const x = Math.cos(ang);
  const y = Math.sin(ang);
  const lift = 2 * Math.PI * turns * t;

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
        <div className="text-lg font-semibold text-slate-900">Sollevamento topologico</div>
        <div className="text-sm text-slate-600 mt-1 leading-relaxed">
          Qui non inseguo una “profondità” geometrica, ma una chiarezza sul percorso. Il cerchio S¹ può essere visto come
          una versione “compattata” della retta reale ℝ: molti angoli diversi (θ, θ+2π, θ+4π, …) finiscono nello stesso
          punto sul cerchio. Il sollevamento scioglie questa identificazione.
        </div>

        <div className="mt-4 grid gap-3">
          <label className="text-sm">
            <div className="text-xs text-slate-600 font-medium">Numero di giri della curva sul cerchio</div>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={turns}
              onChange={(e) => setTurns(parseInt(e.target.value, 10))}
              className="mt-2 w-full"
            />
            <div className="mt-1 text-slate-500">{turns}</div>
          </label>

          <label className="text-sm">
            <div className="text-xs text-slate-600 font-medium">Parametro t (punto evidenziato)</div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={t}
              onChange={(e) => setT(parseFloat(e.target.value))}
              className="mt-2 w-full"
            />
          </label>

          <div className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-50 w-full aspect-[21/9] max-h-[300px]">
            <CircleLiftViz turns={turns} t={t} onChangeT={(u) => setT(u)} />
          </div>

          <div className="text-sm text-slate-600 leading-relaxed">
            Punto su S¹: (cos(2π·{turns}·t), sin(2π·{turns}·t)) = ({x.toFixed(3)}, {y.toFixed(3)})
            <br />
            Sollevamento su ℝ (con base γ̃(0)=0): {lift.toFixed(3)}
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-4">
        <div className="text-lg font-semibold text-slate-900">Perché è diverso dal caso geometrico</div>
        <div className="text-sm text-slate-600 mt-1 leading-relaxed">
          Nel sollevamento geometrico, la stessa proiezione ammette infinite altezze possibili: la non unicità è parte del
          problema. Nel sollevamento topologico, invece, fissato il punto iniziale, il sollevamento è determinato: la curva
          “chiusa” sul cerchio diventa una curva “aperta” sulla retta, e la chiusura dipende dal numero di giri.
        </div>

        <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/60 p-3.5">
          <div className="text-slate-800 font-semibold">Esperimento mentale</div>
          <div className="text-slate-600 mt-2 leading-relaxed">
            Porti t da 0 a 1. Sul cerchio, la curva torna al punto di partenza dopo {turns} giro/i: l’immagine sembra
            ripetizione. Sulla retta, invece, il valore cresce fino a 2π·{turns}: il movimento è avanzamento.
          </div>
        </div>

        <div className="mt-4 text-sm text-slate-600 leading-relaxed">
          Suggerimento: aumenti i giri e osservi come, sul cerchio, l’immagine resti sempre “la stessa idea di ritorno”,
          mentre su ℝ la distanza finale cresce.
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("geo");

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-xl font-semibold text-slate-900">Sollevare una linea</div>
              <div className="text-sm text-slate-600 mt-1 leading-relaxed">
                Una web app per esplorare, in modo visivo, il sollevamento geometrico (proiezioni) e topologico (rivestimenti).
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setTab("geo")}
                className={`rounded-2xl px-4 py-2 text-sm border ${
                  tab === "geo"
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-700 border-slate-300 hover:border-slate-400"
                }`}
              >
                Geometrico
              </button>
              <button
                onClick={() => setTab("topo")}
                className={`rounded-2xl px-4 py-2 text-sm border ${
                  tab === "topo"
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-700 border border-slate-300 hover:border-slate-400"
                }`}
              >
                Topologico
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">
        {tab === "geo" ? <GeometricLifting /> : <TopologicalLifting />}

        <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-slate-900 font-semibold">Idea guida</div>
          <div className="text-slate-600 mt-2 leading-relaxed">
            In entrambi i casi, “sollevare” significa passare da una rappresentazione compressa a una più ricca. Nel caso
            geometrico, recupero (scelgo) una dimensione perduta; nel caso topologico, sciolgo un’identificazione globale
            dello spazio (θ ~ θ + 2π), trasformando un ritorno apparente in un avanzamento misurabile.
          </div>
        </div>
      </main>

      <footer className="pb-10" />
    </div>
  );
}
