import { useRef, useEffect } from 'react';
import type { PressureLabel } from '../types';

// ── Canvas geometry ──────────────────────────────────────────────────────────
const CW = 160, CH = 280;
const BX = 3,  BY = 16, BW = 154, BH = 256, BRX = 14;
const TW = 46, TH = 15;
const BTM = BY + BH;

// ── Color system ─────────────────────────────────────────────────────────────
type RGB = [number, number, number];
const hex  = (h: string): RGB => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
const lerp3 = (a: RGB, b: RGB, t: number): RGB => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
const rgba  = (c: RGB, a = 1) => `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;

// ── Pressure zones: color, bubble count, amplitude, wave speed ───────────────
// Amplitudes are 2.5–3x larger than before so waves are actually visible.
const ZONES = [
  { pct:  0, c: hex('#059669'), maxB:  3, amp: 10, spd: 0.30 },
  { pct: 30, c: hex('#84cc16'), maxB:  6, amp: 14, spd: 0.52 },
  { pct: 50, c: hex('#eab308'), maxB: 10, amp: 19, spd: 0.86 },
  { pct: 65, c: hex('#ea580c'), maxB: 16, amp: 25, spd: 1.40 },
  { pct: 75, c: hex('#dc2626'), maxB: 22, amp: 32, spd: 1.90 },
  { pct: 90, c: hex('#7f1d1d'), maxB: 34, amp: 42, spd: 2.70 },
];

function zoneAt(p: number) {
  let i = 0;
  while (i < ZONES.length - 2 && ZONES[i + 1].pct <= p) i++;
  const a = ZONES[i], b = ZONES[i + 1] ?? a;
  const t = b.pct > a.pct ? Math.min((p - a.pct) / (b.pct - a.pct), 1) : 0;
  return {
    c:    lerp3(a.c, b.c, t) as RGB,
    maxB: Math.round(a.maxB + (b.maxB - a.maxB) * t),
    amp:  a.amp  + (b.amp  - a.amp)  * t,
    spd:  a.spd  + (b.spd  - a.spd)  * t,
  };
}

// ── Canvas round-rect helper ─────────────────────────────────────────────────
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,   x + w, y + h, r);
    ctx.arcTo(x + w, y+h, x,     y + h, r);
    ctx.arcTo(x,     y+h, x,     y,     r);
    ctx.arcTo(x,     y,   x + w, y,     r);
    ctx.closePath();
  }
}

// Target Y: high pressure → liquid near TOP (full = alarming)
const levelY = (p: number) => BY + BH * (1 - Math.max(2, Math.min(98, p)) / 100);

// ── Wave layer descriptors: [freqMult, ampMult, speedMult, phaseOffset] ──────
// Four independent layers; drawn back-to-front with increasing opacity.
const LAYERS: [number, number, number, number][] = [
  [0.38, 0.58, 0.40, 0.80],  // slow deep swell
  [1.48, 0.40, 1.38, 3.14],  // fast surface ripples
  [0.73, 0.65, 0.62, 1.57],  // secondary roll
  [1.00, 1.00, 1.00, 0.00],  // front primary wave
];

// ── Particles ────────────────────────────────────────────────────────────────
interface Bubble  { x: number; y: number; r: number; vy: number; vx: number; op: number; }
interface Caustic { cx: number; cy: number; vx: number; vy: number; r: number; phase: number; spd: number; }

const mkBubble  = (): Bubble  => ({
  x: BX + 8 + Math.random() * (BW - 16),
  y: BTM - Math.random() * 24,
  r: 1.0 + Math.random() * 3.8,
  vy: -(0.40 + Math.random() * 0.85),
  vx: (Math.random() - 0.5) * 0.22,
  op: 0.18 + Math.random() * 0.38,
});

const mkCaustic = (): Caustic => ({
  cx: BX + 22 + Math.random() * (BW - 44),
  cy: BY + 50 + Math.random() * (BH - 90),
  vx: (Math.random() - 0.5) * 0.16,
  vy: (Math.random() - 0.5) * 0.12,
  r:  24 + Math.random() * 34,
  phase: Math.random() * Math.PI * 2,
  spd:   0.30 + Math.random() * 0.50,
});

// ── Wave surface sampler (multi-harmonic for organic look) ────────────────────
function sampleWave(baseY: number, amp: number, freq: number, phase: number, n: number): number {
  return baseY
    + amp        * Math.sin(freq * n * Math.PI * 4 + phase)
    + amp * 0.28 * Math.sin(freq * 2.3 * n * Math.PI * 4 + phase * 1.35 + 0.6)
    + amp * 0.11 * Math.sin(freq * 3.9 * n * Math.PI * 4 - phase * 0.65);
}

// ── Main component ────────────────────────────────────────────────────────────
interface Props { pressure: number; label: PressureLabel; usedGb: number; totalGb: number; }

export function MemoryIndicator({ pressure, label: _label, usedGb, totalGb }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const pressureRef = useRef(pressure);
  pressureRef.current = pressure;

  const s = useRef({
    lY:       levelY(pressure),
    sloshVel: 0,
    col:      zoneAt(pressure).c as RGB,
    waveT:    0,
    bubbles:  [] as Bubble[],
    caustics: Array.from({ length: 8 }, mkCaustic),
    raf:      0,
    lastMs:   0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width  = CW * dpr;
    canvas.height = CH * dpr;
    canvas.style.width  = `${CW}px`;
    canvas.style.height = `${CH}px`;
    ctx.scale(dpr, dpr);

    const st = s.current;
    const noMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ── Per-frame draw ────────────────────────────────────────────────────────
    function draw(dt: number) {
      const p    = pressureRef.current;
      const zone = zoneAt(p);

      // Color transition ~480ms
      st.col = lerp3(st.col, zone.c, 1 - Math.pow(0.002, dt)) as RGB;
      const col = st.col;

      // Spring-damper sloshing (dt-based, critically damped below)
      // k=28 → ω₀≈5.3 rad/s (0.85 Hz), ζ≈0.52 (underdamped: nice slosh)
      const k = 28, c = 5.5;
      st.sloshVel += ((levelY(p) - st.lY) * k - st.sloshVel * c) * dt;
      st.lY += st.sloshVel * dt;
      st.lY  = Math.max(BY + 4, Math.min(BTM - 4, st.lY));

      st.waveT += dt;

      // Bubble lifecycle
      while (st.bubbles.length < zone.maxB) st.bubbles.push(mkBubble());
      while (st.bubbles.length > zone.maxB + 4) st.bubbles.shift();
      st.bubbles = st.bubbles.filter(b => {
        b.y += b.vy * dt * 60;
        b.x += (b.vx + Math.sin(b.y * 0.055) * 0.14) * dt * 60;
        return b.y > st.lY - b.r * 2 && b.x > BX && b.x < BX + BW;
      });

      // Caustic drift (keep below surface)
      st.caustics.forEach(c2 => {
        c2.cx += c2.vx; c2.cy += c2.vy; c2.phase += c2.spd * dt;
        if (c2.cx < BX + 8 || c2.cx > BX + BW - 8) c2.vx *= -1;
        if (c2.cy < st.lY + 10 || c2.cy > BTM - 10) c2.vy *= -1;
        c2.cy = Math.max(st.lY + 10, Math.min(BTM - 10, c2.cy));
      });

      // ── RENDER ──────────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, CW, CH);

      // 1 ── Outer glow (behind battery, tracks fill level)
      ctx.save();
      ctx.shadowColor = rgba(col, 0.7);
      ctx.shadowBlur  = 32;
      ctx.globalAlpha = 0.18;
      ctx.fillStyle   = rgba(col);
      rr(ctx, BX - 10, st.lY - 12, BW + 20, BTM - st.lY + 22, BRX + 10);
      ctx.fill();
      ctx.restore();

      // 2 ── Terminal nub (brushed metal)
      const tx  = (CW - TW) / 2;
      const ntG = ctx.createLinearGradient(tx, 0, tx + TW, 0);
      ntG.addColorStop(0,    '#484848');
      ntG.addColorStop(0.25, '#B8B8B8');
      ntG.addColorStop(0.5,  '#E4E4E4');
      ntG.addColorStop(0.75, '#909090');
      ntG.addColorStop(1,    '#484848');
      ctx.globalAlpha = 0.82;
      ctx.fillStyle   = ntG;
      rr(ctx, tx, 2, TW, TH + 2, 5); ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle   = '#080808';
      rr(ctx, tx + 2, 4, TW - 4, TH - 2, 3); ctx.fill();
      ctx.globalAlpha = 1;

      // 3 ── Battery body dark background
      ctx.fillStyle = '#040404';
      rr(ctx, BX, BY, BW, BH, BRX); ctx.fill();

      // 4 ── Clip to battery body for all liquid content
      ctx.save();
      rr(ctx, BX, BY, BW, BH, BRX); ctx.clip();

      // 4a ── Deep liquid body
      // Correct gradient: translucent near surface → opaque at depth (like real liquid)
      const maxAmp  = zone.amp * 1.3;
      const solidY  = st.lY + maxAmp;
      if (solidY < BTM) {
        const bg = ctx.createLinearGradient(0, solidY, 0, BTM);
        bg.addColorStop(0,   rgba(col, 0.30));  // translucent near surface
        bg.addColorStop(0.3, rgba(col, 0.52));  // mid depth
        bg.addColorStop(0.7, rgba(col, 0.68));  // deeper
        bg.addColorStop(1,   rgba(col, 0.80));  // darkest at bottom
        ctx.fillStyle = bg;
        ctx.fillRect(BX, solidY, BW, BTM - solidY);
      }

      // 4b ── Caustic light blobs (bright white, not liquid color — visible!)
      st.caustics.forEach(c2 => {
        if (c2.cy < st.lY + 12) return;
        const alpha = 0.18 + 0.10 * Math.sin(c2.phase);
        const r2    = c2.r * (0.82 + 0.18 * Math.sin(c2.phase + 1));
        const cg    = ctx.createRadialGradient(c2.cx, c2.cy, 0, c2.cx, c2.cy, r2);
        cg.addColorStop(0,    `rgba(255,255,255,${(alpha * 2.2).toFixed(3)})`);
        cg.addColorStop(0.35, `rgba(255,255,255,${alpha.toFixed(3)})`);
        cg.addColorStop(1,    'rgba(0,0,0,0)');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(c2.cx, c2.cy, r2, 0, Math.PI * 2);
        ctx.fill();
      });

      // 4c ── Wave layers (back to front, layers[0] deepest, layers[3] front)
      for (let li = 0; li < LAYERS.length; li++) {
        const [fM, aM, sM, ph] = LAYERS[li];
        const isFront = li === LAYERS.length - 1;
        const wAmp   = zone.amp * aM;
        const wPhase = st.waveT * zone.spd * sM * Math.PI * 2 + ph;
        // Back layers surface starts slightly LOWER (deeper), creating depth illusion
        const layerBaseY = st.lY + (LAYERS.length - 1 - li) * 3.5;
        const STEPS = 80;

        ctx.beginPath();
        for (let xi = 0; xi <= STEPS; xi++) {
          const n = xi / STEPS;
          const x = BX + n * BW;
          const y = sampleWave(layerBaseY, wAmp, fM, wPhase, n);
          if (xi === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineTo(BX + BW, BTM);
        ctx.lineTo(BX, BTM);
        ctx.closePath();

        if (isFront) {
          // Front wave: semi-transparent gradient — let depth layers show through
          const wg = ctx.createLinearGradient(0, st.lY - wAmp, 0, BTM);
          wg.addColorStop(0,    rgba(col, 0.72));  // reduced from 0.97 — back layers visible
          wg.addColorStop(0.15, rgba(col, 0.82));
          wg.addColorStop(1,    rgba(col, 0.60));
          ctx.fillStyle = wg;
        } else {
          const opacities = [0.20, 0.30, 0.45];
          ctx.fillStyle = rgba(col, opacities[li] ?? 0.20);
        }
        ctx.fill();
      }

      // 4d ── Meniscus — liquid curves up at both walls (Bezier curves)
      const mH = Math.min(zone.amp * 0.55, 10);
      const mW = 26;
      ctx.fillStyle = rgba(col, 0.52);
      // Left wall
      ctx.beginPath();
      ctx.moveTo(BX, st.lY + 2);
      ctx.bezierCurveTo(BX, st.lY - mH, BX + mW * 0.55, st.lY - mH * 0.18, BX + mW, st.lY);
      ctx.lineTo(BX, st.lY);
      ctx.closePath();
      ctx.fill();
      // Right wall
      ctx.beginPath();
      ctx.moveTo(BX + BW, st.lY + 2);
      ctx.bezierCurveTo(BX + BW, st.lY - mH, BX + BW - mW * 0.55, st.lY - mH * 0.18, BX + BW - mW, st.lY);
      ctx.lineTo(BX + BW, st.lY);
      ctx.closePath();
      ctx.fill();

      // 4e ── Bubbles (white translucent spheres)
      st.bubbles.forEach(b => {
        const grad = ctx.createRadialGradient(
          b.x - b.r * 0.3, b.y - b.r * 0.35, 0,
          b.x, b.y, b.r
        );
        grad.addColorStop(0,    `rgba(255,255,255,${(b.op * 0.92).toFixed(3)})`);
        grad.addColorStop(0.55, rgba(col, b.op * 0.42));
        grad.addColorStop(1,    'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        // Rim highlight
        ctx.strokeStyle = `rgba(255,255,255,${(b.op * 0.30).toFixed(3)})`;
        ctx.lineWidth   = 0.6;
        ctx.stroke();
      });

      // 4f ── Surface highlight — bright glowing line following primary wave
      const shPhase = st.waveT * zone.spd * Math.PI * 2;
      ctx.save();
      ctx.shadowColor = rgba(col, 0.90);
      ctx.shadowBlur  = 7;
      ctx.strokeStyle = `rgba(255,255,255,0.82)`;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      for (let xi = 0; xi <= 90; xi++) {
        const n = xi / 90;
        const x = BX + n * BW;
        const y = sampleWave(st.lY, zone.amp, 1, shPhase, n);
        if (xi === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // 4g ── Glass front-panel reflection (diagonal highlight)
      const refl = ctx.createLinearGradient(BX, BY, BX + BW * 0.42, BY + BH * 0.52);
      refl.addColorStop(0,   'rgba(255,255,255,0.09)');
      refl.addColorStop(0.35,'rgba(255,255,255,0.04)');
      refl.addColorStop(0.7, 'rgba(255,255,255,0.01)');
      refl.addColorStop(1,   'rgba(255,255,255,0)');
      ctx.fillStyle = refl;
      ctx.fillRect(BX, BY, BW, BH);

      // 4h ── Top inner shine
      const shine = ctx.createLinearGradient(0, BY, 0, BY + BH * 0.28);
      shine.addColorStop(0, 'rgba(255,255,255,0.08)');
      shine.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = shine;
      rr(ctx, BX, BY, BW, BH * 0.28, BRX); ctx.fill();

      ctx.restore(); // ── End liquid clip ──────────────────────────────────

      // 5 ── Metallic border (brushed metal, left-to-right highlight)
      const metal = ctx.createLinearGradient(BX, BY, BX + BW, BY);
      metal.addColorStop(0,    '#484848');
      metal.addColorStop(0.18, '#A0A0A0');
      metal.addColorStop(0.38, '#D8D8D8');
      metal.addColorStop(0.5,  '#F0F0F0');
      metal.addColorStop(0.62, '#B0B0B0');
      metal.addColorStop(0.82, '#686868');
      metal.addColorStop(1,    '#404040');
      ctx.strokeStyle = metal;
      ctx.lineWidth   = 1.8;
      rr(ctx, BX, BY, BW, BH, BRX); ctx.stroke();

      // Inner rim (subtle)
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth   = 1;
      rr(ctx, BX + 2.5, BY + 2.5, BW - 5, BH - 5, BRX - 2); ctx.stroke();

      // 6 ── Level tick marks (right edge)
      [25, 50, 75].forEach(pct => {
        const ty = BY + BH * (pct / 100);
        ctx.strokeStyle = 'rgba(180,180,180,0.20)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(BX + BW - 13, ty);
        ctx.lineTo(BX + BW - 3,  ty);
        ctx.stroke();
      });

      // 7 ── Percentage text (centered in the liquid body)
      if (st.lY < BY + BH * 0.80) {
        const textY = Math.max(st.lY + (BTM - st.lY) / 2 + 10, st.lY + 30);
        ctx.save();
        ctx.shadowColor = rgba(col, 0.55);
        ctx.shadowBlur  = 14;
        ctx.font        = '600 26px "SF Mono","JetBrains Mono",monospace';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle   = 'rgba(255,255,255,0.92)';
        ctx.fillText(`${Math.round(p)}%`, BX + BW / 2, textY);
        ctx.restore();
      }
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    function loop(ms: number) {
      const dt = Math.min((ms - st.lastMs) / 1000, 0.05);
      st.lastMs = ms;
      draw(dt);
      st.raf = requestAnimationFrame(loop);
    }

    if (noMotion) {
      st.lY    = levelY(pressureRef.current);
      st.waveT = 0;
      draw(0);
    } else {
      st.raf = requestAnimationFrame(ms => { st.lastMs = ms; loop(ms); });
    }

    return () => cancelAnimationFrame(st.raf);
  }, []);

  return (
    <div className="memory-battery-wrap">
      <canvas ref={canvasRef} className="memory-battery-canvas" />
      <div className="battery-usage-small">{usedGb.toFixed(1)} / {totalGb.toFixed(0)} GB</div>
    </div>
  );
}
