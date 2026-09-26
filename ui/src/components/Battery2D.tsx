import { useRef, useEffect } from 'react';

// ── Canvas dimensions ─────────────────────────────────────────────────────────
const CW = 176;
const CH = 316;

// ── Wave definitions (speed in rad/sec) ──────────────────────────────────────
const WAVES = [
  { amp: 6,  freq: 0.020, spd:  1.80 },
  { amp: 4,  freq: 0.035, spd: -1.20 },
  { amp: 2,  freq: 0.050, spd:  2.40 },
  { amp: 3,  freq: 0.015, spd:  0.90 },
  { amp: 5,  freq: 0.025, spd: -1.50 },
];

function waveFactors(p: number): { a: number; s: number } {
  if (p < 30) return { a: 0.60, s: 0.60 };
  if (p < 50) return { a: 0.75, s: 0.75 };
  if (p < 65) return { a: 1.00, s: 1.00 };
  if (p < 75) return { a: 1.30, s: 1.30 };
  if (p < 90) return { a: 1.70, s: 1.70 };
  return           { a: 2.20, s: 2.00 };
}

// ── Liquid color ──────────────────────────────────────────────────────────────
type RGB = [number, number, number];

function liquidRGB(p: number): RGB {
  if (p < 30) return [5, 150, 105];
  if (p < 50) return [101, 163, 13];
  if (p < 65) return [202, 138, 4];
  if (p < 75) return [234, 88, 12];
  if (p < 90) return [220, 38, 38];
  return [127, 29, 29];
}

export function liquidHex(p: number): string {
  if (p < 30) return '#059669';
  if (p < 50) return '#84cc16';
  if (p < 65) return '#eab308';
  if (p < 75) return '#ea580c';
  if (p < 90) return '#dc2626';
  return '#7f1d1d';
}

function rgba([r, g, b]: RGB, a: number) { return `rgba(${r|0},${g|0},${b|0},${a})`; }
function lighten([r, g, b]: RGB, t: number): RGB { return [r + (255-r)*t, g + (255-g)*t, b + (255-b)*t]; }
function darken ([r, g, b]: RGB, t: number): RGB { return [r*(1-t), g*(1-t), b*(1-t)]; }

// ── Animation state ───────────────────────────────────────────────────────────
interface Bubble { x: number; y: number; r: number; spd: number; op: number; }
interface FoamDot { x: number; ph: number; r: number; spd: number; }
interface Caustic  { x: number; y: number; dx: number; dy: number; r: number; ph: number; }

interface AnimState {
  fill:    number;
  vel:     number;
  target:  number;
  slosh:   number;
  phases:  number[];
  bubbles: Bubble[];
  foam:    FoamDot[];
  caustics: Caustic[];
}

interface Props {
  pressure:        number;
  usedGb:          number;
  totalGb:         number;
  animSpeed?:      'calm' | 'normal' | 'intense';
  scrollVelocity?: number;
}

interface TiltSpring { angle: number; vel: number; target: number; }

const SPEED_FACTOR = { calm: 0.5, normal: 1.0, intense: 2.0 } as const;

export function Battery2DCanvas({ pressure, usedGb, totalGb, animSpeed = 'normal', scrollVelocity = 0 }: Props) {
  const canvasRef          = useRef<HTMLCanvasElement>(null);
  const stateRef           = useRef<AnimState | null>(null);
  const pressureRef        = useRef(pressure);
  const prevPRef           = useRef(pressure);
  const animSpeedRef       = useRef(SPEED_FACTOR[animSpeed]);
  const scrollVelocityRef  = useRef(scrollVelocity);

  pressureRef.current       = pressure;
  animSpeedRef.current      = SPEED_FACTOR[animSpeed];
  scrollVelocityRef.current = scrollVelocity;

  const tiltRef        = useRef<TiltSpring>({ angle: 0, vel: 0, target: 0 });
  const wrapRef        = useRef<HTMLDivElement>(null);
  const frameRef       = useRef<HTMLDivElement>(null);
  const draggingRef    = useRef(false);
  const dragStartX     = useRef(0);
  const dragStartAngle = useRef(0);

  // ── Animation loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const p0  = pressureRef.current;

    // Multi-size bubble pool: 5 large + 8 medium + 12 small
    const bubbles: Bubble[] = [
      ...Array.from({ length: 5  }, () => ({
        x: 12 + Math.random() * (CW - 24),
        y: CH * (0.35 + Math.random() * 0.55),
        r: 14 + Math.random() * 8,
        spd: 0.14 + Math.random() * 0.18,
        op: 0.11 + Math.random() * 0.09,
      })),
      ...Array.from({ length: 8  }, () => ({
        x: 12 + Math.random() * (CW - 24),
        y: CH * (0.25 + Math.random() * 0.65),
        r: 6  + Math.random() * 5,
        spd: 0.26 + Math.random() * 0.30,
        op: 0.17 + Math.random() * 0.13,
      })),
      ...Array.from({ length: 12 }, () => ({
        x: 12 + Math.random() * (CW - 24),
        y: CH * (0.15 + Math.random() * 0.78),
        r: 1.5 + Math.random() * 3,
        spd: 0.40 + Math.random() * 0.65,
        op: 0.20 + Math.random() * 0.20,
      })),
    ];

    const foam: FoamDot[] = Array.from({ length: 16 }, () => ({
      x:   10 + Math.random() * (CW - 20),
      ph:  Math.random() * Math.PI * 2,
      r:   1.4 + Math.random() * 2.6,
      spd: 0.7  + Math.random() * 1.1,
    }));

    const caustics: Caustic[] = Array.from({ length: 3 }, () => ({
      x:  30 + Math.random() * (CW - 60),
      y:  CH * 0.4 + Math.random() * CH * 0.4,
      dx: (Math.random() - 0.5) * 0.28,
      dy: (Math.random() - 0.5) * 0.20,
      r:  12 + Math.random() * 10,
      ph: Math.random() * Math.PI * 2,
    }));

    stateRef.current = {
      fill: p0 / 100, vel: 0, target: p0 / 100,
      slosh: 0, phases: [0, 0, 0, 0, 0],
      bubbles, foam, caustics,
    };

    let rafId  = 0;
    let lastTs = 0;
    let t      = 0;

    function frame(ts: number) {
      const dt  = Math.min((ts - lastTs) / 1000, 0.05);
      lastTs    = ts;
      t        += dt;

      const st  = stateRef.current!;
      const p   = pressureRef.current;
      const spd = animSpeedRef.current;
      const sv  = scrollVelocityRef.current;

      // Fill spring
      const acc = 120 * (st.target - st.fill) - 13 * st.vel;
      st.vel   += acc * dt;
      st.fill  += st.vel * dt;
      st.fill   = Math.max(0.005, Math.min(0.995, st.fill));

      // Slosh decay + scroll boost
      st.slosh = Math.max(0, st.slosh - dt * 1.4);
      if (sv > 1) st.slosh = Math.min(st.slosh + sv * 0.06 * dt, 3.2);

      // Tilt spring (K=80, D=14)
      const tr    = tiltRef.current;
      const tacc  = 80 * (tr.target - tr.angle) - 14 * tr.vel;
      tr.vel     += tacc * dt;
      tr.angle   += tr.vel * dt;
      tr.angle    = Math.max(-8, Math.min(8, tr.angle));

      if (wrapRef.current) {
        const a = tr.angle;
        wrapRef.current.style.transform =
          `perspective(600px) rotateY(${a}deg) rotateX(${-Math.abs(a) * 0.18}deg)`;
      }
      if (frameRef.current) {
        const a   = tr.angle;
        const hex = liquidHex(pressureRef.current);
        const sx  = +(a * -2.5).toFixed(1);
        frameRef.current.style.boxShadow =
          `${sx}px 14px 40px rgba(0,0,0,0.5), 0 0 44px ${hex}28, 0 0 90px ${hex}10`;
      }

      // Wave phases
      const wf  = waveFactors(p);
      const amp = spd > 1 ? Math.sqrt(spd) : 1;
      for (let i = 0; i < 5; i++) st.phases[i] += WAVES[i].spd * wf.s * dt * spd;

      const numW  = p >= 75 ? 5 : 4;
      const sMul  = 1 + st.slosh * 0.45;
      const topY  = CH - st.fill * CH;

      const waveAt = (x: number): number => {
        const xNorm   = (x - CW / 2) / (CW / 2);
        const tiltOff = xNorm * tr.angle * (-1.8);
        let dy = 0;
        for (let i = 0; i < numW; i++) {
          dy += Math.sin(x * WAVES[i].freq + st.phases[i]) * WAVES[i].amp * wf.a * sMul * amp;
        }
        return topY + tiltOff + dy;
      };

      ctx.clearRect(0, 0, CW, CH);
      if (st.fill < 0.008) { rafId = requestAnimationFrame(frame); return; }

      const col  = liquidRGB(p);
      const colL = lighten(col, 0.20);
      const colD = darken(col, 0.42);
      const colH = lighten(col, 0.50);

      // ── Liquid fill ──────────────────────────────────────────────
      ctx.beginPath();
      ctx.moveTo(0, CH);
      for (let x = 0; x <= CW; x += 2) ctx.lineTo(x, waveAt(x));
      ctx.lineTo(CW, CH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, topY - 24, 0, CH);
      g.addColorStop(0.00, rgba(colL, 0.85));
      g.addColorStop(0.10, rgba(col,  0.90));
      g.addColorStop(0.72, rgba(col,  0.95));
      g.addColorStop(1.00, rgba(colD, 1.00));
      ctx.fillStyle = g;
      ctx.fill();

      // ── Vertical caustic light column (oscillates) ───────────────
      const caustX = CW * 0.5 + Math.sin(t * 0.38) * CW * 0.22;
      const caustW = 14 + 7 * Math.abs(Math.sin(t * 0.7));
      const cg = ctx.createLinearGradient(caustX - caustW, 0, caustX + caustW, 0);
      cg.addColorStop(0,   rgba(colL, 0));
      cg.addColorStop(0.5, rgba(colL, 0.085));
      cg.addColorStop(1,   rgba(colL, 0));
      ctx.fillStyle = cg;
      ctx.fillRect(caustX - caustW, topY + 2, caustW * 2, CH - topY - 2);

      // ── Scattered caustics (ambient) ─────────────────────────────
      for (const c of st.caustics) {
        c.x += c.dx; c.y += c.dy;
        if (c.x < c.r || c.x > CW - c.r) c.dx *= -1;
        if (c.y < topY + 4) { c.y = topY + c.r + 4; c.dy = Math.abs(c.dy); }
        if (c.y > CH - c.r) c.dy *= -1;
        const pulse = 1.1 + 0.22 * Math.sin(t * 0.9 + c.ph);
        const scg   = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r * pulse);
        scg.addColorStop(0, rgba(colL, 0.07));
        scg.addColorStop(1, rgba(col,  0));
        ctx.fillStyle = scg;
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r * pulse * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Bubbles (visible full travel, pop at surface) ────────────
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, CW, CH);
      ctx.clip();

      // Bubble count scales with pressure
      const activeBubbles = Math.min(
        st.bubbles.length,
        (4 + (p / 8) | 0),
      );

      for (let bi = 0; bi < activeBubbles; bi++) {
        const b  = st.bubbles[bi];
        const bx = b.x + Math.sin(b.y * 0.12 + t) * Math.min(b.r * 0.35, 3.5);

        // Pop when bubble top reaches the wave surface
        if (b.y - b.r < waveAt(b.x)) {
          b.y = CH - 4;
          b.x = 12 + Math.random() * (CW - 24);
        }
        b.y -= b.spd * spd;

        // Bubble body
        ctx.beginPath();
        ctx.arc(bx, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(colL, b.op * 0.48);
        ctx.fill();

        // Bubble rim
        ctx.strokeStyle = rgba(colL, b.op * 0.85);
        ctx.lineWidth   = Math.max(0.5, b.r * 0.07);
        ctx.stroke();

        // Highlight dot (top-left → spherical look)
        if (b.r > 3) {
          ctx.beginPath();
          ctx.arc(bx - b.r * 0.28, b.y - b.r * 0.30, b.r * 0.26, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.40)';
          ctx.fill();
        }
      }
      ctx.restore();

      // ── Foam at surface ───────────────────────────────────────────
      const foamActive = Math.min((2 + (p * 0.12)) | 0, st.foam.length);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, topY - 28, CW, 32);
      ctx.clip();
      for (let fi = 0; fi < foamActive; fi++) {
        const f  = st.foam[fi];
        const fx = f.x + Math.sin(t * f.spd + f.ph) * 9;
        const fy = waveAt(fx) - f.r * 0.6;
        ctx.beginPath();
        ctx.arc(fx, fy, f.r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(colH, 0.20 + 0.09 * Math.sin(t * 2.2 + fi * 0.9));
        ctx.fill();
      }
      ctx.restore();

      // ── Wave surface highlight ────────────────────────────────────
      ctx.beginPath();
      ctx.moveTo(0, waveAt(0));
      for (let x = 2; x <= CW; x += 2) ctx.lineTo(x, waveAt(x));
      ctx.strokeStyle = rgba(colH, 0.75);
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // ── Cylindrical edge shading ──────────────────────────────────
      // Left shadow (cylinder side curving away)
      const lsh = ctx.createLinearGradient(0, 0, 26, 0);
      lsh.addColorStop(0, 'rgba(0,0,0,0.44)');
      lsh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lsh;
      ctx.fillRect(0, 0, 26, CH);

      // Right shadow
      const rsh = ctx.createLinearGradient(CW - 26, 0, CW, 0);
      rsh.addColorStop(0, 'rgba(0,0,0,0)');
      rsh.addColorStop(1, 'rgba(0,0,0,0.36)');
      ctx.fillStyle = rsh;
      ctx.fillRect(CW - 26, 0, 26, CH);

      // ── Glass highlight lines (inner edge of glass wall) ─────────
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(7, 18); ctx.lineTo(7, CH - 18); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath(); ctx.moveTo(CW - 7, 18); ctx.lineTo(CW - 7, CH - 18); ctx.stroke();

      // ── Violent splashes (p ≥ 90) ────────────────────────────────
      if (p >= 90 && Math.random() < 0.22) {
        const sx = 15 + Math.random() * (CW - 30);
        ctx.beginPath();
        ctx.arc(sx, waveAt(sx) - 4 - Math.random() * 14, 1 + Math.random() * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = rgba(colH, 0.55 + Math.random() * 0.35);
        ctx.fill();
      }

      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ── Global mouse-up (end drag) ─────────────────────────────────────────────
  useEffect(() => {
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current    = false;
      tiltRef.current.target = 0;
      if (stateRef.current) stateRef.current.slosh = Math.min(stateRef.current.slosh + 1.0, 3.5);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // ── Pressure change → update target + add slosh ────────────────────────────
  useEffect(() => {
    if (!stateRef.current) return;
    const prev = prevPRef.current;
    prevPRef.current         = pressure;
    stateRef.current.target  = pressure / 100;
    if (Math.abs(pressure - prev) > 4) {
      stateRef.current.slosh = Math.min(stateRef.current.slosh + 0.55, 2.2);
    }
  }, [pressure]);

  const hex = liquidHex(pressure);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (draggingRef.current) {
      const dx = e.clientX - dragStartX.current;
      tiltRef.current.target = Math.max(-8, Math.min(8, dragStartAngle.current + dx * 0.18));
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      const cx   = (e.clientX - rect.left) / rect.width;
      tiltRef.current.target = (cx - 0.5) * 16;
    }
  };
  const handleMouseLeave = () => { if (!draggingRef.current) tiltRef.current.target = 0; };
  const handleMouseDown  = (e: React.MouseEvent) => {
    draggingRef.current    = true;
    dragStartX.current     = e.clientX;
    dragStartAngle.current = tiltRef.current.target;
  };
  const handleMouseUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current       = false;
    tiltRef.current.target    = 0;
    if (stateRef.current) stateRef.current.slosh = Math.min(stateRef.current.slosh + 1.2, 3.5);
  };
  const handleClick = () => {
    if (stateRef.current) stateRef.current.slosh = 5.0;
  };

  return (
    <div className="battery2d-wrap" ref={wrapRef} style={{ transformOrigin: 'center bottom' }}>
      <div className="battery-terminal" aria-hidden="true">
        <div className="battery-terminal-nub" />
      </div>
      <div className="battery-gasket" aria-hidden="true" />
      <div
        ref={frameRef}
        className="battery-frame"
        style={{ boxShadow: `0 0 44px ${hex}28, 0 0 90px ${hex}10`, cursor: 'grab' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
      >
        <div className="battery-inner">
          <canvas ref={canvasRef} width={CW} height={CH} />
          <div className="battery-glass-overlay" aria-hidden="true" />
          <div className="battery-text" aria-hidden="true">
            <div className="battery-pct">{Math.round(pressure)}%</div>
            <div className="battery-sub">Memory Pressure</div>
          </div>
        </div>
      </div>
      <div className="battery2d-label">{usedGb.toFixed(1)} / {totalGb.toFixed(0)} GB</div>
    </div>
  );
}
