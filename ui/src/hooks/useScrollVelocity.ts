import { useEffect, useRef, useState } from 'react';

export interface ScrollState {
  velocity: number;       // 0–10 normalised
  direction: 'up' | 'down';
  isScrolling: boolean;
}

export function useScrollVelocity(): ScrollState {
  const [state, setState] = useState<ScrollState>({ velocity: 0, direction: 'down', isScrolling: false });
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTs    = useRef(0);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const now = performance.now();
      const dt  = Math.max(now - lastTs.current, 1);
      lastTs.current = now;
      const v = Math.min(Math.abs(e.deltaY / dt) * 8, 10);

      setState({ velocity: v, direction: e.deltaY > 0 ? 'down' : 'up', isScrolling: true });

      clearTimeout(stopTimer.current);
      stopTimer.current = setTimeout(() => {
        setState(s => ({ ...s, velocity: 0, isScrolling: false }));
      }, 200);
    };

    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('wheel', onWheel);
      clearTimeout(stopTimer.current);
    };
  }, []);

  return state;
}
