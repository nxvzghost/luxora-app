'use client';

import { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost';
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const base: React.CSSProperties = {
    fontFamily: 'var(--font-body)',
    fontSize: '0.9375rem',
    fontWeight: 600,
    padding: '0.75rem 1.5rem',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    cursor: props.disabled ? 'not-allowed' : 'pointer',
    opacity: props.disabled ? 0.6 : 1,
    transition: 'transform 120ms ease, box-shadow 120ms ease',
    ...(variant === 'primary'
      ? { background: 'var(--forest)', color: 'var(--paper)' }
      : { background: 'transparent', color: 'var(--forest)', border: '1px solid var(--border)' }),
  };

  return <button {...props} className={className} style={{ ...base, ...props.style }} />;
}
