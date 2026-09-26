import { useRef } from 'react';

interface Props {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  'aria-label'?: string;
}

export function MagneticButton({ children, onClick, className = '', disabled, style, 'aria-label': ariaLabel }: Props) {
  const ref = useRef<HTMLButtonElement>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    const btn = ref.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top  - rect.height / 2;
    btn.style.transform  = `translate(${(x * 0.15).toFixed(1)}px, ${(y * 0.15).toFixed(1)}px)`;
    btn.style.transition = 'transform 80ms ease-out';
  };

  const handleMouseLeave = () => {
    const btn = ref.current;
    if (!btn) return;
    btn.style.transform  = 'translate(0, 0)';
    btn.style.transition = 'transform 300ms ease-out';
  };

  return (
    <button
      ref={ref}
      className={className}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      disabled={disabled}
      style={style}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}
