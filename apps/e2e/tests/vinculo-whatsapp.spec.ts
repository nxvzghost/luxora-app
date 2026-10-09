import { createClinic, createPendingContact, readContactLink, removeClinic } from '../support/database';
import { expect, openMenu, signIn, test } from '../support/fixtures';

/**
 * Vínculo de um número novo do WhatsApp a um paciente que já existe —
 * ADR-0063 (AD-038). A aprovação é do administrador, pelo painel: é ela, e
 * não o que a pessoa disse na conversa, que faz o número identificar o
 * paciente. Tudo pela tela, contra a API e o banco reais.
 */
test.describe('Vínculo de número novo do WhatsApp', () => {
  test('o administrador aprova o vínculo; fica gravado quem aprovou e o número sai da lista', async ({ page, clinic }) => {
    const [ana] = clinic.patients;
    const contact = await createPendingContact(clinic.tenantId, ana.name);

    await signIn(page, clinic.admin);
    await openMenu(page, 'Pacientes');

    const section = page.getByRole('region', { name: 'Números aguardando vínculo' });
    const row = section.getByRole('listitem').filter({ hasText: contact.phoneNumber });
    await expect(row).toContainText(`Nome informado na conversa: ${ana.name}`);
    await expect(row.getByRole('button', { name: 'Vincular' })).toBeDisabled();

    await row.getByRole('combobox').selectOption(ana.id);
    await row.getByRole('button', { name: 'Vincular' }).click();

    // A confirmação diz o que muda — e, até ela, nada foi gravado.
    const dialog = page.getByRole('dialog', { name: 'Aprovar o vínculo deste número?' });
    await expect(dialog).toContainText(contact.phoneNumber);
    await expect(dialog).toContainText(ana.name);
    await expect(dialog).toContainText('por outro meio');
    expect(await readContactLink(contact.id)).toMatchObject({ state: 'Identificado', patientIds: [], audit: null });

    await dialog.getByRole('button', { name: 'Aprovar vínculo' }).click();

    await expect(section.getByRole('status')).toContainText(`O número ${contact.phoneNumber} agora identifica ${ana.name}`);
    await expect(row).toHaveCount(0);
    await expect(section).toContainText('Nenhum número aguardando vínculo.');

    // No banco: o vínculo, quem aprovou e quando.
    const link = await readContactLink(contact.id);
    expect(link.state).toBe('Vinculado');
    expect(link.patientIds).toEqual([ana.id]);
    expect(link.audit).toMatchObject({
      userId: clinic.admin.id,
      actorType: 'user',
      payload: { patientId: ana.id, approvedByUserId: clinic.admin.id },
    });
    expect(Number.isNaN(Date.parse(String(link.audit?.payload?.approvedAt)))).toBe(false);

    // Lido de volta do servidor: o número não volta para a lista, e o
    // telefone do cadastro do paciente continua o mesmo.
    await page.reload();
    await expect(page.getByRole('region', { name: 'Números aguardando vínculo' })).toContainText('Nenhum número aguardando vínculo.');
    await expect(page.getByRole('listitem').filter({ hasText: ana.name })).toContainText('+5541900000000');

    // E a aprovação aparece na Auditoria, como ação de um usuário.
    await openMenu(page, 'Auditoria');
    const entry = page.getByRole('listitem').filter({ hasText: 'ContatoVinculadoAPacienteExistente' });
    await expect(entry).toContainText('Usuário');
    await expect(entry).toContainText(clinic.admin.id);
  });

  test('desistir na confirmação não vincula nada', async ({ page, clinic }) => {
    const [, bruno] = clinic.patients;
    const contact = await createPendingContact(clinic.tenantId, null);

    await signIn(page, clinic.admin);
    await openMenu(page, 'Pacientes');
    const row = page.getByRole('region', { name: 'Números aguardando vínculo' }).getByRole('listitem').filter({ hasText: contact.phoneNumber });
    await expect(row).toContainText('Não informou nome');

    await row.getByRole('combobox').selectOption(bruno.id);
    await row.getByRole('button', { name: 'Vincular' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Voltar' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).toBeVisible();
    expect(await readContactLink(contact.id)).toMatchObject({ state: 'Conversando', patientIds: [], audit: null });
  });

  test('perfil terapeuta não vê os números aguardando vínculo', async ({ page, clinic }) => {
    const contact = await createPendingContact(clinic.tenantId, 'Alguém Qualquer Teste');

    await signIn(page, clinic.therapistUser);
    await openMenu(page, 'Pacientes');

    await expect(page.getByText(clinic.patients[0].name)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Números aguardando vínculo' })).toHaveCount(0);
    await expect(page.getByText(contact.phoneNumber)).toHaveCount(0);
  });

  test('a lista só traz números da própria clínica', async ({ page, clinic }) => {
    const otherClinic = await createClinic();
    try {
      const foreign = await createPendingContact(otherClinic.tenantId, 'Contato De Outra Clínica');

      await signIn(page, clinic.admin);
      await openMenu(page, 'Pacientes');

      const section = page.getByRole('region', { name: 'Números aguardando vínculo' });
      await expect(section).toContainText('Nenhum número aguardando vínculo.');
      await expect(page.getByText(foreign.phoneNumber)).toHaveCount(0);
      await expect(page.getByText('Contato De Outra Clínica')).toHaveCount(0);
    } finally {
      await removeClinic(otherClinic.tenantId);
    }
  });
});
