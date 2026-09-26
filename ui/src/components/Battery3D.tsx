import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { RoundedBox, Environment, Html } from '@react-three/drei';
import * as THREE from 'three';

// ── Pressure config (color + wave behavior) ───────────────────────────────────
interface PConfig { color: string; emissive: string; amp: number; speed: number; }
function pressureCfg(p: number): PConfig {
  if (p < 30) return { color: '#059669', emissive: '#065f46', amp: 0.016, speed: 0.8 };
  if (p < 50) return { color: '#65a30d', emissive: '#3f6212', amp: 0.030, speed: 1.3 };
  if (p < 65) return { color: '#ca8a04', emissive: '#713f12', amp: 0.052, speed: 2.0 };
  if (p < 75) return { color: '#ea580c', emissive: '#7c2d12', amp: 0.082, speed: 2.8 };
  if (p < 90) return { color: '#dc2626', emissive: '#7f1d1d', amp: 0.120, speed: 3.8 };
  return             { color: '#991b1b', emissive: '#450a0a', amp: 0.165, speed: 5.2 };
}

// ── Inner battery dimensions ──────────────────────────────────────────────────
const INNER_H = 2.55;   // fillable height
const INNER_W = 1.72;   // inner liquid width
const INNER_D = 0.58;   // inner liquid depth
const INNER_BOT = -(INNER_H / 2);  // -1.275

// ── Wave surface shaders ──────────────────────────────────────────────────────
const WAVE_VERT = /* glsl */`
  uniform float time;
  uniform float amp;
  varying vec2  vUv;
  varying vec3  vNorm;

  void main() {
    vUv  = uv;
    vec3 p = position;
    // Position is in XY plane; rotation.x = -PI/2 makes it horizontal.
    // Displacing Z here becomes world-Y after rotation.
    float w = sin(p.x * 4.4  + time * 1.8)          * amp * 1.00
            + sin(p.x * 8.9  + p.y*3.6 - time*2.6)  * amp * 0.50
            + sin(p.y * 6.3  + time * 2.2)            * amp * 0.33
            + sin(p.x * 14.0 + p.y*9.5 - time*3.5)   * amp * 0.18
            + sin(p.x * 2.6  - p.y*4.2 + time * 1.1) * amp * 0.13;
    p.z += w;
    vNorm = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const WAVE_FRAG = /* glsl */`
  uniform vec3  liquidColor;
  varying vec2  vUv;
  varying vec3  vNorm;

  void main() {
    vec3 eye  = normalize(vec3(0.0, 0.1, 1.0));
    vec3 ld   = normalize(vec3(1.2, 2.0, 1.4));
    float fresnel = pow(1.0 - max(dot(vNorm, eye), 0.0), 2.6);
    float diff    = max(dot(vNorm, ld), 0.0);
    float spec    = pow(max(dot(reflect(-ld, vNorm), eye), 0.0), 52.0);

    // Caustic shimmer from UV
    float caus = 0.5 + 0.5 * sin(vUv.x * 20.0 + vUv.y * 14.0);

    vec3 col = liquidColor * (0.62 + diff * 0.42)
             + vec3(1.0)   * fresnel * 0.55
             + vec3(1.0)   * spec    * 0.75
             + liquidColor * caus    * 0.09;

    gl_FragColor = vec4(col, 0.97);
  }
`;

// ── Bubbles (only in liquid zone) ─────────────────────────────────────────────
function Bubbles({ fillBotRef, fillTopRef }: {
  fillBotRef: React.MutableRefObject<number>;
  fillTopRef: React.MutableRefObject<number>;
}) {
  const COUNT = 10;
  const meshRefs = useRef<(THREE.Mesh | null)[]>(Array(COUNT).fill(null));

  const init = useMemo(() => Array.from({ length: COUNT }, () => ({
    x:     (Math.random() - 0.5) * INNER_W * 0.82,
    speed: 0.005 + Math.random() * 0.010,
    r:     0.011 + Math.random() * 0.018,
    wAmp:  0.022 + Math.random() * 0.032,
    phase: Math.random() * Math.PI * 2,
  })), []);

  useFrame(() => {
    const bot = fillBotRef.current;
    const top = fillTopRef.current;
    if (top - bot < 0.18) { meshRefs.current.forEach(m => { if (m) m.visible = false; }); return; }
    for (let i = 0; i < COUNT; i++) {
      const mesh = meshRefs.current[i];
      if (!mesh) continue;
      mesh.visible = true;
      mesh.position.y += init[i].speed;
      mesh.position.x = init[i].x + Math.sin(mesh.position.y * 6.8 + init[i].phase) * init[i].wAmp;
      if (mesh.position.y > top - 0.06) {
        mesh.position.y = bot + 0.04 + Math.random() * 0.15;
        mesh.position.x = (Math.random() - 0.5) * INNER_W * 0.82;
      }
    }
  });

  return (
    <>
      {init.map((d, i) => (
        <mesh key={i} ref={el => { meshRefs.current[i] = el; }}
          position={[d.x, INNER_BOT + 0.1 + Math.random() * 0.5, 0]}>
          <sphereGeometry args={[d.r, 7, 7]} />
          <meshPhysicalMaterial transparent opacity={0.50} transmission={0.88}
            roughness={0.05} thickness={0.03} ior={1.33} />
        </mesh>
      ))}
    </>
  );
}

// ── Steam (pressure > 75) ─────────────────────────────────────────────────────
function Steam({ fillTopRef, pressureRef }: {
  fillTopRef: React.MutableRefObject<number>;
  pressureRef: React.MutableRefObject<number>;
}) {
  const COUNT = 14;
  const meshRefs = useRef<(THREE.Mesh | null)[]>(Array(COUNT).fill(null));
  const init = useMemo(() => Array.from({ length: COUNT }, () => ({
    x: (Math.random() - 0.5) * INNER_W * 0.85,
    speed: 0.007 + Math.random() * 0.010,
    phase: Math.random() * Math.PI * 2,
  })), []);

  useFrame(() => {
    const p   = pressureRef.current;
    const top = fillTopRef.current;
    for (let i = 0; i < COUNT; i++) {
      const mesh = meshRefs.current[i];
      if (!mesh) continue;
      if (p < 75) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.y += init[i].speed;
      mesh.position.x = init[i].x + Math.sin(mesh.position.y * 2.8 + init[i].phase) * 0.055;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const relY = mesh.position.y - top;
      mat.opacity = Math.max(0, 0.28 - relY * 0.65);
      if (mat.opacity <= 0.01 || mesh.position.y > top + 0.55) {
        mesh.position.set(init[i].x + (Math.random() - 0.5) * 0.3, top + 0.02, 0);
      }
    }
  });

  return (
    <>
      {init.map((d, i) => (
        <mesh key={i} ref={el => { meshRefs.current[i] = el; }} position={[d.x, 0, 0]}>
          <sphereGeometry args={[0.016, 5, 5]} />
          <meshStandardMaterial color="#c5d8ff" transparent opacity={0.22} depthWrite={false} />
        </mesh>
      ))}
    </>
  );
}

// ── Main battery scene ────────────────────────────────────────────────────────
interface Props { pressure: number; usedGb: number; totalGb: number; }

function BatteryScene({ pressure }: Pick<Props, 'pressure'>) {
  const groupRef    = useRef<THREE.Group>(null!);
  const fillBotRef  = useRef(INNER_BOT);
  const fillTopRef  = useRef(INNER_BOT);
  const pressureRef = useRef(pressure);
  pressureRef.current = pressure;

  const waveUniforms = useRef({
    time:        { value: 0 },
    amp:         { value: 0.032 },
    liquidColor: { value: new THREE.Color(pressureCfg(pressure).color) },
  });

  useFrame(({ clock, pointer }) => {
    const p = pressureRef.current;
    const cfg = pressureCfg(p);
    const fillFrac   = Math.max(0.01, Math.min(0.99, p / 100));
    const fillHeight = fillFrac * INNER_H;
    fillBotRef.current = INNER_BOT;
    fillTopRef.current = INNER_BOT + fillHeight;

    waveUniforms.current.time.value = clock.getElapsedTime();
    waveUniforms.current.amp.value  = cfg.amp;
    waveUniforms.current.liquidColor.value.set(cfg.color);

    if (!groupRef.current) return;
    groupRef.current.rotation.y  = Math.sin(clock.getElapsedTime() * 0.12) * 0.055;
    groupRef.current.rotation.x += (-pointer.y * 0.14 - groupRef.current.rotation.x) * 0.040;
    groupRef.current.rotation.z += ( pointer.x * 0.08 - groupRef.current.rotation.z) * 0.040;
  });

  const cfg        = pressureCfg(pressure);
  const fillFrac   = Math.max(0.01, Math.min(0.99, pressure / 100));
  const fillHeight = fillFrac * INNER_H;
  const fillCenY   = INNER_BOT + fillHeight / 2;
  const fillTopY   = INNER_BOT + fillHeight;
  // Clamp text so it doesn't exit glass top
  const textY      = Math.min(fillTopY + 0.26, 1.10);

  return (
    <group ref={groupRef}>
      {/* ── Lights ── */}
      <directionalLight position={[2, 4, 3]}    intensity={1.3} />
      <directionalLight position={[-2, 2, -1]}  intensity={0.3} color="#6080ff" />
      <pointLight position={[0, fillCenY, 0.45]} intensity={3.8} color={cfg.color} distance={3.0} decay={2} />
      <pointLight position={[0, 1.8,  1]}        intensity={0.7} color="#ffffff" distance={3.5} decay={2} />
      <ambientLight intensity={0.22} />

      {/* ── Floor glow (simulated reflection) ── */}
      <mesh position={[0, -1.58, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[3.2, 1.8]} />
        <meshBasicMaterial color={cfg.color} transparent opacity={0.06} depthWrite={false} />
      </mesh>

      {/* ── Liquid body ── */}
      {fillHeight > 0.04 && (
        <mesh position={[0, fillCenY, 0]}>
          <boxGeometry args={[INNER_W, Math.max(0.02, fillHeight), INNER_D]} />
          <meshStandardMaterial
            color={cfg.color}
            emissive={cfg.emissive}
            emissiveIntensity={0.32}
            transparent opacity={0.90}
          />
        </mesh>
      )}

      {/* ── Wave surface ── */}
      {fillHeight > 0.12 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, fillTopY, 0]}>
          <planeGeometry args={[INNER_W, INNER_D, 32, 20]} />
          <shaderMaterial
            vertexShader={WAVE_VERT}
            fragmentShader={WAVE_FRAG}
            uniforms={waveUniforms.current}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* ── Bubbles (inside liquid) ── */}
      <Bubbles fillBotRef={fillBotRef} fillTopRef={fillTopRef} />

      {/* ── Steam (pressure > 75) ── */}
      <Steam fillTopRef={fillTopRef} pressureRef={pressureRef} />

      {/* ── Terminal nub on top ── */}
      <mesh position={[0, 1.54, 0]}>
        <cylinderGeometry args={[0.30, 0.26, 0.24, 20]} />
        <meshStandardMaterial color="#9ca3af" metalness={0.85} roughness={0.20} />
      </mesh>
      {/* Nub cap highlight */}
      <mesh position={[0, 1.67, 0]}>
        <cylinderGeometry args={[0.22, 0.22, 0.02, 20]} />
        <meshStandardMaterial color="#d1d5db" metalness={0.95} roughness={0.12} />
      </mesh>

      {/* ── Glass shell (renders on top, transparent) ── */}
      <RoundedBox args={[2.0, 2.95, 0.84]} radius={0.14} smoothness={5} renderOrder={3}>
        <meshPhysicalMaterial
          transmission={0.90}
          roughness={0.03}
          thickness={0.65}
          ior={1.50}
          color="#d4e8ff"
          transparent
          opacity={0.88}
          clearcoat={1.0}
          clearcoatRoughness={0.04}
          reflectivity={0.70}
          envMapIntensity={1.4}
        />
      </RoundedBox>

      {/* ── Percentage ABOVE liquid surface ── */}
      {fillHeight > 0.08 && (
        <Html center position={[0, textY, 0.46]} style={{ pointerEvents: 'none' }}>
          <div style={{
            fontFamily: '"SF Mono","JetBrains Mono",monospace',
            fontSize: '15px', fontWeight: 700,
            color: 'rgba(255,255,255,0.96)',
            textShadow: `0 0 16px ${cfg.color}cc, 0 0 36px ${cfg.color}66`,
            letterSpacing: '-0.2px',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            background: 'rgba(0,0,0,0.15)',
            backdropFilter: 'blur(4px)',
            padding: '1px 6px',
            borderRadius: '4px',
            border: `1px solid ${cfg.color}44`,
          }}>
            {Math.round(pressure)}%
          </div>
        </Html>
      )}
    </group>
  );
}

// ── Canvas wrapper ────────────────────────────────────────────────────────────
export function Battery3DCanvas({ pressure, usedGb, totalGb }: Props) {
  return (
    <div className="battery3d-wrap">
      <Canvas
        camera={{ position: [0, 0.12, 5.0], fov: 50 }}
        gl={{ antialias: true, alpha: true }}
        dpr={Math.min(window.devicePixelRatio, 2)}
        style={{ background: 'transparent' }}
      >
        <Environment preset="night" />
        <BatteryScene pressure={pressure} />
      </Canvas>
      <div className="battery3d-label">{usedGb.toFixed(1)} / {totalGb.toFixed(0)} GB</div>
    </div>
  );
}
