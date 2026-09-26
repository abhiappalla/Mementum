import { useRef, useCallback } from 'react';

export function useParallax(intensity = 3) {
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.transition = 'none';
    el.style.transform = `perspective(800px) rotateX(${-y * intensity}deg) rotateY(${x * intensity}deg) translateZ(6px)`;
  }, [intensity]);

  const onMouseLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = 'transform 480ms cubic-bezier(0.34,1.2,0.64,1)';
    el.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg) translateZ(0px)';
    timerRef.current = setTimeout(() => {
      if (ref.current) {
        ref.current.style.transform = '';
        ref.current.style.transition = '';
      }
      timerRef.current = null;
    }, 520);
  }, []);

  return { ref, onMouseMove, onMouseLeave };
}
