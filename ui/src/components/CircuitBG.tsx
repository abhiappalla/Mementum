import { useRef, useEffect } from 'react';

const GOLD = 'rgba(212,175,55,';
const EXTRA_H = 500; // extra canvas height for scroll parallax headroom

// ── Types ──────────────────────────────────────────────────────────────────────
interface Seg  { x0: number; y0: number; x1: number; y1: number; }
interface PCBTrace { segs: Seg[]; op: number; }
interface Comp {
  type: 'via' | 'cap' | 'res' | 'ic';
  x: number; y: number; w: number; h: number; op: number;
}
interface Signal {
  traceIdx: number; pos: number; speed: number; len: number; dir: 1 | -1;
}

// ── Layout builder ──────────────────────────────────────────────────────────────
function buildLayout(W: number, H: number) {
  const TH = H + EXTRA_H;   // total drawable height
  const traces: PCBTrace[] = [];
  const comps:  Comp[]     = [];

  // 1. Horizontal bus lines (thick grid backbone)
  let y = 20;
  while (y < TH) {
    const xS = Math.random() < 0.25 ? Math.round(Math.random() * 80) : 0;
    const xE = Math.random() < 0.25 ? W - Math.round(Math.random() * 80) : W;
    traces.push({ segs: [{ x0: xS, y0: y, x1: xE, y1: y }], op: 0.04 + Math.random() * 0.02 });
    // parallel pair trace
    if (Math.random() < 0.45) {
      traces.push({ segs: [{ x0: xS, y0: y + 4, x1: xE, y1: y + 4 }], op: 0.03 + Math.random() * 0.015 });
    }
    y += 40 + Math.round(Math.random() * 80);
  }

  // 2. Vertical trunk lines
  let x = 20;
  while (x < W) {
    const yS = Math.random() < 0.25 ? Math.round(Math.random() * 60) : 0;
    const yE = Math.random() < 0.25 ? TH - Math.round(Math.random() * 60) : TH;
    traces.push({ segs: [{ x0: x, y0: yS, x1: x, y1: yE }], op: 0.04 + Math.random() * 0.02 });
    if (Math.random() < 0.35) {
      traces.push({ segs: [{ x0: x + 4, y0: yS, x1: x + 4, y1: yE }], op: 0.03 + Math.random() * 0.015 });
    }
    x += 50 + Math.round(Math.random() * 100);
  }

  // 3. Right-angle signal paths (50 paths, 1-4 turns each)
  for (let i = 0; i < 50; i++) {
    const segs: Seg[] = [];
    let cx = Math.round(Math.random() * W);
    let cy = Math.round(Math.random() * TH);
    const turns = 1 + Math.floor(Math.random() * 3);
    let horiz = Math.random() < 0.5;
    for (let j = 0; j <= turns; j++) {
      const len = 40 + Math.round(Math.random() * 160);
      const sign = Math.random() < 0.5 ? 1 : -1;
      const nx = horiz ? Math.max(0, Math.min(W, cx + sign * len)) : cx;
      const ny = horiz ? cy : Math.max(0, Math.min(TH, cy + sign * len));
      if (Math.abs(nx - cx) > 3 || Math.abs(ny - cy) > 3) {
        segs.push({ x0: cx, y0: cy, x1: nx, y1: ny });
      }
      cx = nx; cy = ny; horiz = !horiz;
    }
    if (segs.length > 0) {
      traces.push({ segs, op: 0.04 + Math.random() * 0.025 });
    }
  }

  // 4. Short via stubs (tiny vertical segments connecting layers)
  for (let i = 0; i < 35; i++) {
    const vx = Math.round(Math.random() * W);
    const vy = Math.round(Math.random() * TH);
    const vl = 15 + Math.round(Math.random() * 50);
    traces.push({ segs: [{ x0: vx, y0: vy, x1: vx, y1: vy + vl }], op: 0.04 + Math.random() * 0.02 });
  }

  // ── Components ────────────────────────────────────────────────────────────────

  // Vias: small circles with ring
  for (let i = 0; i < 70; i++) {
    comps.push({ type: 'via', x: Math.random() * W, y: Math.random() * TH,
      w: 2 + Math.random() * 2.5, h: 0, op: 0.04 + Math.random() * 0.02 });
  }
  // Capacitors: tall rectangles
  for (let i = 0; i < 30; i++) {
    comps.push({ type: 'cap', x: Math.random() * W, y: Math.random() * TH,
      w: 7 + Math.random() * 5, h: 13 + Math.random() * 9, op: 0.035 + Math.random() * 0.02 });
  }
  // Resistors: wide rectangles
  for (let i = 0; i < 25; i++) {
    comps.push({ type: 'res', x: Math.random() * W, y: Math.random() * TH,
      w: 18 + Math.random() * 12, h: 6 + Math.random() * 4, op: 0.03 + Math.random() * 0.02 });
  }
  // IC chips: large rectangles with pin stubs
  for (let i = 0; i < 9; i++) {
    const iw = 55 + Math.random() * 70, ih = 45 + Math.random() * 60;
    comps.push({ type: 'ic', x: Math.random() * (W - iw), y: Math.random() * (TH - ih),
      w: iw, h: ih, op: 0.03 + Math.random() * 0.02 });
  }

  return { traces, comps };
}

// ── Length of a trace ────────────────────────────────────────────────────────────
function traceLen(t: PCBTrace): number {
  return t.segs.reduce((s, sg) => {
    const dx = sg.x1 - sg.x0, dy = sg.y1 - sg.y0;
    return s + Math.sqrt(dx * dx + dy * dy);
  }, 0);
}

// ── Point at distance along trace ────────────────────────────────────────────────
function ptAt(t: PCBTrace, dist: number): { x: number; y: number } {
  let d = 0;
  for (const sg of t.segs) {
    const dx = sg.x1 - sg.x0, dy = sg.y1 - sg.y0;
    const l  = Math.sqrt(dx * dx + dy * dy);
    if (d + l >= dist) {
      const f = (dist - d) / l;
      return { x: sg.x0 + dx * f, y: sg.y0 + dy * f };
    }
    d += l;
  }
  const last = t.segs[t.segs.length - 1];
  return { x: last.x1, y: last.y1 };
}

// ── Public component ──────────────────────────────────────────────────────────────
export function CircuitBG({ enabled = true }: { enabled?: boolean }) {
  if (!enabled) return null;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef   = useRef<{ traces: PCBTrace[]; comps: Comp[]; signals: Signal[] } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    let W = window.innerWidth;
    let H = window.innerHeight;

    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      canvas.width  = W; canvas.height = H;
      init();
    }

    function init() {
      const { traces, comps } = buildLayout(W, H);
      const eligible = traces.map((t, i) => ({ i, l: traceLen(t) })).filter(e => e.l > 60);
      const shuffled = [...eligible].sort(() => Math.random() - 0.5).slice(0, 13);
      const signals: Signal[] = shuffled.map(({ i, l }) => ({
        traceIdx: i, pos: Math.random() * l,
        speed: 70 + Math.random() * 130, len: l,
        dir: (Math.random() < 0.5 ? 1 : -1) as 1 | -1,
      }));
      dataRef.current = { traces, comps, signals };
    }

    resize();
    window.addEventListener('resize', resize);

    let rafId = 0;
    let lastTs = 0;

    function frame(ts: number) {
      const dt   = Math.min((ts - lastTs) / 1000, 0.05);
      lastTs = ts;
      const data = dataRef.current;
      if (!data) { rafId = requestAnimationFrame(frame); return; }

      const scrollTop  = (document.querySelector('.tab-content') as HTMLElement | null)?.scrollTop ?? 0;
      const scrollOff  = scrollTop * 0.30;

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(0, -scrollOff);

      // ── Draw static traces ────────────────────────────────────────
      for (const t of data.traces) {
        ctx.strokeStyle = GOLD + t.op + ')';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        const s0 = t.segs[0];
        ctx.moveTo(s0.x0, s0.y0);
        for (const sg of t.segs) ctx.lineTo(sg.x1, sg.y1);
        ctx.stroke();
      }

      // ── Draw components ───────────────────────────────────────────
      for (const c of data.comps) {
        ctx.lineWidth   = 0.8;
        ctx.strokeStyle = GOLD + c.op + ')';
        ctx.fillStyle   = GOLD + (c.op * 0.12) + ')';

        if (c.type === 'via') {
          ctx.beginPath();
          ctx.arc(c.x, c.y, c.w, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(c.x, c.y, c.w * 1.8, 0, Math.PI * 2);
          ctx.stroke();
        } else if (c.type === 'cap' || c.type === 'res') {
          ctx.strokeRect(c.x - c.w / 2, c.y - c.h / 2, c.w, c.h);
        } else if (c.type === 'ic') {
          ctx.strokeRect(c.x, c.y, c.w, c.h);
          ctx.beginPath();
          const PIN = 7;
          // left pins
          for (let py = c.y + 10; py < c.y + c.h - 5; py += PIN) {
            ctx.moveTo(c.x - 5, py); ctx.lineTo(c.x, py);
          }
          // right pins
          for (let py = c.y + 10; py < c.y + c.h - 5; py += PIN) {
            ctx.moveTo(c.x + c.w, py); ctx.lineTo(c.x + c.w + 5, py);
          }
          // top pins
          for (let px = c.x + 10; px < c.x + c.w - 5; px += PIN) {
            ctx.moveTo(px, c.y - 5); ctx.lineTo(px, c.y);
          }
          // bottom pins
          for (let px = c.x + 10; px < c.x + c.w - 5; px += PIN) {
            ctx.moveTo(px, c.y + c.h); ctx.lineTo(px, c.y + c.h + 5);
          }
          ctx.stroke();
        }
      }

      // ── Draw traveling signal dots ────────────────────────────────
      for (const sig of data.signals) {
        sig.pos += sig.speed * sig.dir * dt;
        if (sig.pos >= sig.len) { sig.pos = sig.len; sig.dir = -1; }
        if (sig.pos <= 0)       { sig.pos = 0;       sig.dir =  1; }

        const pt = ptAt(data.traces[sig.traceIdx], sig.pos);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
        ctx.fillStyle   = GOLD + '0.15)';
        ctx.shadowColor = '#D4AF37';
        ctx.shadowBlur  = 5;
        ctx.fill();
        ctx.shadowBlur  = 0;
      }

      ctx.restore();
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none' }}
    />
  );
}
