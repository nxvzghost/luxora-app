import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '../support/render-with-query';
import { apiError, fakeToken, mockApi } from '../support/mock-api';
import { useAuthStore } from '@/lib/stores/auth.store';
import PacientesPage from '@/app/pacientes/page';

/**
 * A-10 da auditoria (19/10/2026) — o administrador desfaz pelo painel um
 * vínculo de número que a clínica aprovou. Até aqui só se corrigia no banco.
 */
describe('PacientesPage — números vinculados (A-10)', () => {
  const ANA = { id: 'patient-1', name: 'Ana Teste', phone: '+5541900000001', state: 'Ativo', billingPolicyOverride: null };
  const LINK = { contactId: 'contact-1', phoneNumber: '+5541988887777', patientId: 'patient-1', patientName: 'Ana Teste', linkedAt: '2026-10-19T12:00:00.000Z' };
  const BASE = { 'GET /patients': { body: { data: [ANA] } }, 'GET /contacts/pending': { body: { data: [] } } };

  const section = () => screen.getByRole('region', { name: 'Números vinculados' });

  beforeEach(() => {
    useAuthStore.setState({ accessToken: fakeToken('admin'), refreshToken: 'fake-refresh' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null });
  });

  it('nenhum vínculo aprovado: a seção diz isso, sem parecer erro', async () => {
    mockApi({ ...BASE, 'GET /contacts/linked': { body: { data: [] } } });
    renderWithQueryClient(<PacientesPage />);
    expect(await within(section()).findByText('Nenhum número vinculado por aprovação.')).toBeInTheDocument();
    expect(within(section()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('falha ao carregar: mostra o erro e não diz que não há nenhum', async () => {
    mockApi({ ...BASE, 'GET /contacts/linked': apiError(500, 'INTERNAL', 'erro simulado') });
    renderWithQueryClient(<PacientesPage />);
    expect(await within(section()).findByRole('alert')).toBeInTheDocument();
    expect(within(section()).queryByText('Nenhum número vinculado por aprovação.')).not.toBeInTheDocument();
  });

  it('clicar em Desfazer vínculo ainda não desfaz: pede a confirmação, dizendo o que muda', async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...BASE, 'GET /contacts/linked': { body: { data: [LINK] } } });
    renderWithQueryClient(<PacientesPage />);

    await user.click(await within(section()).findByRole('button', { name: 'Desfazer vínculo' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('+5541988887777');
    expect(dialog).toHaveTextContent('deixará de identificar Ana Teste');
    expect(api.sent('POST', '/contacts/:id/unlink')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Voltar' }));
    expect(api.sent('POST', '/contacts/:id/unlink')).toHaveLength(0);
  });

  it('confirmar envia o contato e o paciente, avisa na tela e tira o número da lista', async () => {
    const user = userEvent.setup();
    let links = [LINK];
    const api = mockApi({
      ...BASE,
      'GET /contacts/linked': () => ({ body: { data: [...links] } }),
      'POST /contacts/:id/unlink': () => {
        links = [];
        return {
          body: { contactId: 'contact-1', patientId: 'patient-1', state: 'Identificado', undoneByUserId: 'user-1', undoneAt: '2026-10-19T13:00:00.000Z' },
        };
      },
    });
    renderWithQueryClient(<PacientesPage />);

    await user.click(await within(section()).findByRole('button', { name: 'Desfazer vínculo' }));
    await user.click(screen.getByRole('button', { name: 'Desfazer o vínculo' }));

    expect(await within(section()).findByRole('status')).toHaveTextContent('O número +5541988887777 não identifica mais Ana Teste no WhatsApp.');
    const sent = api.sent('POST', '/contacts/:id/unlink');
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/contacts/contact-1/unlink');
    expect(sent[0].body).toEqual({ patientId: 'patient-1' });
    expect(await within(section()).findByText('Nenhum número vinculado por aprovação.')).toBeInTheDocument();
    // A lista de pendentes também é pedida de novo: o número volta para lá.
    expect(api.sent('GET', '/contacts/pending').length).toBeGreaterThanOrEqual(2);
  });

  it('recusa da API: o motivo aparece na própria confirmação e o número continua na lista', async () => {
    const user = userEvent.setup();
    mockApi({
      ...BASE,
      'GET /contacts/linked': { body: { data: [LINK] } },
      'POST /contacts/:id/unlink': apiError(409, 'CONFLICT', 'Este número consta no cadastro do paciente.'),
    });
    renderWithQueryClient(<PacientesPage />);

    await user.click(await within(section()).findByRole('button', { name: 'Desfazer vínculo' }));
    await user.click(screen.getByRole('button', { name: 'Desfazer o vínculo' }));

    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Este número consta no cadastro do paciente.');
    expect(within(section()).queryByRole('status')).not.toBeInTheDocument();
    // O número continua na lista, com o botão para tentar de novo.
    expect(within(section()).getByRole('button', { name: 'Desfazer vínculo' })).toBeInTheDocument();
  });
});
