import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '@/components/ui/feedback';

/**
 * ConfirmDialog — Tarefa 06 da auditoria (AD-031). É a confirmação das ações
 * que não têm volta (cancelar consulta, estornar, desativar usuário). As
 * telas que o usam já provam o caminho feliz e o erro; aqui fica o que é do
 * próprio diálogo: sair sem confirmar e não aceitar nada enquanto a ação roda.
 */
function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Estornar este pagamento?"
      description="O estorno não pode ser desfeito."
      confirmLabel="Estornar"
      busyLabel="Estornando..."
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('diz o que vai acontecer e só age no botão de confirmar', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();

    const dialog = screen.getByRole('dialog', { name: 'Estornar este pagamento?' });
    expect(dialog).toHaveTextContent('O estorno não pode ser desfeito.');
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Estornar' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('"Voltar" e a tecla Esc saem sem confirmar', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('com a ação em andamento: os dois botões travam, o rótulo muda e Esc não fecha', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog({ busy: true });

    const running = screen.getByRole('button', { name: 'Estornando...' });
    expect(running).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeDisabled();

    await user.click(running);
    await user.keyboard('{Escape}');

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
