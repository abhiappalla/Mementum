import { useCallback, useEffect, useRef, useState } from 'react';
import logoUrl from '../assets/logo.png';

interface Vec2 { x: number; y: number; }

// Normalized circuit paths (0–1). All routes converge toward center (0.5, 0.5).
const PATHS: Vec2[][] = [
  // Left side
  [{ x: 0, y: 0.20 }, { x: 0.22, y: 0.20 }, { x: 0.22, y: 0.36 }, { x: 0.50, y: 0.36 }],
  [{ x: 0, y: 0.50 }, { x: 0.16, y: 0.50 }, { x: 0.16, y: 0.44 }, { x: 0.50, y: 0.44 }],
  [{ x: 0, y: 0.72 }, { x: 0.25, y: 0.72 }, { x: 0.25, y: 0.56 }, { x: 0.50, y: 0.56 }],
  [{ x: 0, y: 0.88 }, { x: 0.34, y: 0.88 }, { x: 0.34, y: 0.64 }, { x: 0.50, y: 0.64 }],
  // Right side
  [{ x: 1, y: 0.22 }, { x: 0.78, y: 0.22 }, { x: 0.78, y: 0.36 }, { x: 0.50, y: 0.36 }],
  [{ x: 1, y: 0.50 }, { x: 0.84, y: 0.50 }, { x: 0.84, y: 0.44 }, { x: 0.50, y: 0.44 }],
  [{ x: 1, y: 0.70 }, { x: 0.76, y: 0.70 }, { x: 0.76, y: 0.56 }, { x: 0.50, y: 0.56 }],
  [{ x: 1, y: 0.86 }, { x: 0.66, y: 0.86 }, { x: 0.66, y: 0.64 }, { x: 0.50, y: 0.64 }],
  // Top
  [{ x: 0.28, y: 0 }, { x: 0.28, y: 0.16 }, { x: 0.42, y: 0.16 }, { x: 0.42, y: 0.36 }],
  [{ x: 0.65, y: 0 }, { x: 0.65, y: 0.20 }, { x: 0.58, y: 0.20 }, { x: 0.58, y: 0.36 }],
  // Bottom
  [{ x: 0.22, y: 1 }, { x: 0.22, y: 0.84 }, { x: 0.42, y: 0.84 }, { x: 0.42, y: 0.64 }],
  [{ x: 0.70, y: 1 }, { x: 0.70, y: 0.80 }, { x: 0.58, y: 0.80 }, { x: 0.58, y: 0.64 }],
];

const MESSAGES = [
  'Analyzing Memory Topology',
  'Building Process Graph',
  'Initializing Protection Engine',
  'Optimization Engine Ready',
];

interface Particle {
  segIndex: number;
  progress: number;
  speed: number;
  trail: Vec2[];
  done: boolean;
}

interface ConvergingParticle {
  x: number; y: number;
  vx: number; vy: number;
}

function segLen(path: Vec2[], si: number, w: number, h: number): number {
  const a = path[si], b = path[si + 1];
  const dx = (b.x - a.x) * w, dy = (b.y - a.y) * h;
  return Math.sqrt(dx * dx + dy * dy);
}

function lerpPt(path: Vec2[], si: number, t: number, w: number, h: number): Vec2 {
  const a = path[si], b = path[si + 1];
  return {
    x: (a.x + (b.x - a.x) * t) * w,
    y: (a.y + (b.y - a.y) * t) * h,
  };
}

type MsgPhase = 'active' | 'exiting' | 'entering';

export function LoadingScreen({ onComplete }: { onComplete: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [msgIndex, setMsgIndex] = useState(0);
  const [msgPhase, setMsgPhase] = useState<MsgPhase>('active');
  const [logoOpacity, setLogoOpacity] = useState(0.25);
  const [fadeOut, setFadeOut] = useState(false);
  const phaseRef = useRef(0);
  const particlesRef = useRef<Particle[]>([]);
  const convergingRef = useRef<ConvergingParticle[]>([]);
  const rafRef = useRef<number>(0);

  // Keep a stable ref to onComplete so the effect below never re-runs when
  // the parent re-renders (which happens on every daemon poll).
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; });

  // Status message cycling with slot-machine transition (exit → enter → active)
  const cycle = useCallback((nextIdx: number) => {
    setMsgPhase('exiting');
    const t1 = setTimeout(() => {
      setMsgIndex(nextIdx);
      setMsgPhase('entering');
      // Let the entering frame paint before transitioning to active
      const t2 = setTimeout(() => setMsgPhase('active'), 30);
      return t2;
    }, 380);
    return t1;
  }, []);

  useEffect(() => {
    // Respect prefers-reduced-motion — skip 4s animation entirely
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLogoOpacity(1);
      setMsgIndex(3);
      setMsgPhase('active');
      const t = setTimeout(() => {
        setFadeOut(true);
        setTimeout(() => onCompleteRef.current(), 200);
      }, 400);
      return () => clearTimeout(t);
    }

    const t0 = setTimeout(() => cycle(1), 1000);
    const t1 = setTimeout(() => cycle(2), 2000);
    const t2 = setTimeout(() => { cycle(3); setLogoOpacity(1); }, 3000);
    const t3 = setTimeout(() => {
      setFadeOut(true);
      setTimeout(() => onCompleteRef.current(), 600);
    }, 4000);

    return () => [t0, t1, t2, t3].forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Canvas animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    particlesRef.current = PATHS.map(() => ({
      segIndex: 0,
      progress: Math.random() * 0.3,
      speed: 160 + Math.random() * 80,
      trail: [],
      done: false,
    }));

    let lastTime = performance.now();

    const drawBg = (bgAlpha: number) => {
      const w = canvas.width, h = canvas.height;
      ctx.save();
      PATHS.forEach(path => {
        ctx.beginPath();
        ctx.moveTo(path[0].x * w, path[0].y * h);
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(path[i].x * w, path[i].y * h);
        }
        ctx.strokeStyle = `rgba(192,192,192,${bgAlpha})`;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Vias at waypoints
        for (let i = 1; i < path.length - 1; i++) {
          ctx.beginPath();
          ctx.arc(path[i].x * w, path[i].y * h, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(192,192,192,${bgAlpha * 2.5})`;
          ctx.fill();
        }
      });
      ctx.restore();
    };

    const drawParticle = (pos: Vec2, trail: Vec2[]) => {
      // Trail
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1], b = trail[i];
        const alpha = (i / trail.length) * 0.65;
        ctx.beginPath();
        ctx.strokeStyle = `rgba(212,175,55,${alpha})`;
        ctx.lineWidth = 1.5;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // Outer glow
      const g1 = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 12);
      g1.addColorStop(0, 'rgba(246,226,122,0.20)');
      g1.addColorStop(1, 'rgba(212,175,55,0)');
      ctx.beginPath();
      ctx.fillStyle = g1;
      ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
      ctx.fill();
      // Mid
      const g2 = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 5);
      g2.addColorStop(0, 'rgba(246,226,122,0.9)');
      g2.addColorStop(1, 'rgba(212,175,55,0)');
      ctx.beginPath();
      ctx.fillStyle = g2;
      ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
      ctx.fill();
      // Core
      ctx.beginPath();
      ctx.fillStyle = '#F6E27A';
      ctx.arc(pos.x, pos.y, 2, 0, Math.PI * 2);
      ctx.fill();
    };

    const animate = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const w = canvas.width, h = canvas.height;
      const phase = phaseRef.current;

      ctx.fillStyle = '#0A0A0A';
      ctx.fillRect(0, 0, w, h);

      const bgAlpha = phase === 0 ? 0.055 : Math.min(0.055 + (now / 1000 - 3) * 0.08, 0.22);
      drawBg(bgAlpha);

      if (phase === 0) {
        particlesRef.current.forEach((p, i) => {
          const path = PATHS[i];
          const sl = segLen(path, p.segIndex, w, h);
          p.progress += sl > 0 ? (p.speed * dt) / sl : 0;

          if (p.progress >= 1) {
            p.progress = 0;
            p.segIndex++;
            if (p.segIndex >= path.length - 1) {
              p.segIndex = 0;
              p.trail = [];
            }
          }

          const pos = lerpPt(path, p.segIndex, p.progress, w, h);
          p.trail.push({ ...pos });
          if (p.trail.length > 35) p.trail.shift();
          drawParticle(pos, p.trail);
        });
      } else {
        // Converge phase
        if (convergingRef.current.length === 0) {
          convergingRef.current = particlesRef.current.map(p => {
            const pos = p.trail.length > 0 ? p.trail[p.trail.length - 1] : { x: w / 2, y: h / 2 };
            return {
              x: pos.x, y: pos.y,
              vx: (w / 2 - pos.x) * 1.2,
              vy: (h / 2 - pos.y) * 1.2,
            };
          });
        }
        convergingRef.current.forEach(p => {
          const ax = (w / 2 - p.x) * 4;
          const ay = (h / 2 - p.y) * 4;
          p.vx = p.vx * 0.92 + ax * dt;
          p.vy = p.vy * 0.92 + ay * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;

          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 8);
          g.addColorStop(0, 'rgba(246,226,122,0.5)');
          g.addColorStop(1, 'rgba(212,175,55,0)');
          ctx.beginPath();
          ctx.fillStyle = g;
          ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = '#F6E27A';
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    const phaseTimer = setTimeout(() => { phaseRef.current = 1; }, 3000);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
      clearTimeout(phaseTimer);
    };
  }, []);

  return (
    <div className={`loading-screen${fadeOut ? ' fade-out' : ''}`}>
      <canvas ref={canvasRef} className="loading-canvas" />
      <div className="loading-content">
        <img
          src={logoUrl}
          alt="MEMentum"
          className="loading-logo-img"
          style={{ opacity: logoOpacity }}
        />
        <div className="loading-tagline">Intelligent Memory Management</div>
        <div className="loading-status-container">
          <div className={`loading-status ${msgPhase}`}>
            {MESSAGES[msgIndex]}
          </div>
        </div>
      </div>
    </div>
  );
}
