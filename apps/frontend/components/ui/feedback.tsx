'use client';

import { useEffect, useId } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Peças de estado de tela — Tarefa 05 da auditoria. Um único jeito de
 * dizer "carregando", "deu erro", "deu certo" e "não há nada", com os
 * papéis de acessibilidade certos (alert interrompe, status não).
 */

export function ErrorMessage({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.875rem', margin: '0.75rem 0' }}>
      {children}
    </p>
  );
}

export function SuccessMessage({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="status" style={{ color: 'var(--success)', fontSize: '0.875rem', margin: '0.75rem 0' }}>
      {children}
    </p>
  );
}

export function Loading({ children = 'Carregando...' }: { children?: React.ReactNode }) {
  return <p style={{ color: 'var(--sage)' }}>{children}</p>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p style={{ color: 'var(--sage)' }}>{children}</p>;
}

interface ConfirmDialogProps {
  title: string;
  /** O que vai acontecer, em uma frase — inclusive o que não tem volta. */
  description: React.ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

/**
 * Confirmação antes de uma ação destrutiva ou financeira (cancelar
 * consulta, estornar, desativar usuário). Fica aberta enquanto a ação roda
 * e mostra o erro aqui mesmo, para a pessoa não perder o contexto.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const titleId = useId();
  const { onCancel, busy } = props;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, busy]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(28, 43, 39, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 20,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          background: '#fff',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border)',
          padding: '1.5rem',
          width: '100%',
          maxWidth: '440px',
        }}
      >
        <h2 id={titleId} style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 500, margin: '0 0 0.5rem' }}>
          {props.title}
        </h2>
        <div style={{ fontSize: '0.9375rem', margin: 0 }}>{props.description}</div>
        {props.children}
        <ErrorMessage>{props.error}</ErrorMessage>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.25rem' }}>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Voltar
          </Button>
          <Button type="button" disabled={busy} onClick={props.onConfirm}>
            {busy ? (props.busyLabel ?? 'Aguarde...') : props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
