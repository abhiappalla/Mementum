import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';

// ── Gold dust particles (520, complex noise drift + cursor repulsion) ──────────
const PARTICLE_COUNT = 520;

function noiseOffset(x: number, y: number, t: number): [number, number] {
  const nx = Math.sin(x * 1.3 + y * 2.7 + t * 0.4) * 0.5;
  const ny = Math.cos(x * 2.9 - y * 1.1 + t * 0.3) * 0.5;
  return [nx, ny];
}

function GoldParticles({ mouseRef }: { mouseRef: React.MutableRefObject<{ x: number; y: number }> }) {
  const pointsRef = useRef<THREE.Points>(null!);

  const { geo, speeds, phases, origX } = useMemo(() => {
    const pos    = new Float32Array(PARTICLE_COUNT * 3);
    const speeds = new Float32Array(PARTICLE_COUNT);
    const phases = new Float32Array(PARTICLE_COUNT);
    const origX  = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const x = (Math.random() - 0.5) * 24;
      const y = (Math.random() - 0.5) * 18;
      const z = (Math.random() - 0.5) * 9 - 5;
      pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z;
      origX[i]  = x;
      speeds[i] = 0.002 + Math.random() * 0.009;
      phases[i] = Math.random() * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return { geo, speeds, phases, origX };
  }, []);

  useFrame(({ clock }) => {
    const arr = geo.attributes.position.array as Float32Array;
    const t   = clock.getElapsedTime();
    const mx  = mouseRef.current.x * 12;
    const my  = mouseRef.current.y * 9;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const px = arr[i*3], py = arr[i*3+1];
      const dx = px - mx, dy = py - my;
      const dist = Math.sqrt(dx*dx + dy*dy);

      if (dist < 3.8 && dist > 0.01) {
        const f = ((3.8 - dist) / 3.8) * 0.016;
        arr[i*3]   += (dx / dist) * f;
        arr[i*3+1] += (dy / dist) * f;
      }

      const [nx, ny] = noiseOffset(px * 0.18, py * 0.18, t * 0.2 + phases[i]);
      arr[i*3]   += nx * speeds[i] * 0.55;
      arr[i*3+1] += speeds[i] + ny * speeds[i] * 0.40;
      arr[i*3]   += (origX[i] - arr[i*3]) * 0.0025;

      if (arr[i*3+1] > 9)  arr[i*3+1] = -9;
      if (arr[i*3+1] < -9) arr[i*3+1] =  9;
      if (arr[i*3] >  13)  arr[i*3] = -13;
      if (arr[i*3] < -13)  arr[i*3] =  13;
    }
    geo.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef} geometry={geo}>
      <pointsMaterial
        color="#D4AF37"
        size={0.018}
        transparent
        opacity={0.45}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

// ── Scene content ─────────────────────────────────────────────────────────────
function SceneContent({ mouseRef }: { mouseRef: React.MutableRefObject<{ x: number; y: number }> }) {
  return (
    <>
      <GoldParticles mouseRef={mouseRef} />
      <EffectComposer>
        <Bloom intensity={0.22} luminanceThreshold={0.78} luminanceSmoothing={0.28} mipmapBlur />
        <Vignette offset={0.32} darkness={0.90} />
      </EffectComposer>
    </>
  );
}

// ── Public component ──────────────────────────────────────────────────────────
export function Scene3D({ enabled = true }: { enabled?: boolean }) {
  if (!enabled) return null;
  const mouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let last = 0;
    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - last < 16) return;
      last = now;
      mouseRef.current.x =  (e.clientX / window.innerWidth)  * 2 - 1;
      mouseRef.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
      <Canvas camera={{ position: [0, 0, 8], fov: 60 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}>
        <SceneContent mouseRef={mouseRef} />
      </Canvas>
    </div>
  );
}
