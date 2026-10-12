import { appointmentRow, bookAppointment, clinicDate, expect, openMenu, signIn, test } from '../support/fixtures';

/**
 * Tarefa 07 da auditoria — AD-039 (ADR-0064): o fuso da clínica pelo painel.
 *
 * O navegador destes testes fica em Brasília (`timezoneId` do Playwright) e o
 * backend, no fuso da máquina (UTC no CI). Quando a clínica passa para
 * Manaus (uma hora atrás de Brasília), a agenda tem de oferecer e mostrar os
 * horários na hora de Manaus — não na do navegador.
 */
const IN_THREE_DAYS = clinicDate(3);
const IN_FOUR_DAYS = clinicDate(4);

test.describe('Fuso horário da clínica', () => {
  test('o administrador troca o fuso; a agenda passa a valer e a aparecer na hora do novo fuso, e o que já estava marcado não é reescrito', async ({
    page,
    clinicWithHours: clinic,
  }) => {
    const [ana, bruno] = clinic.patients;
    await signIn(page, clinic.admin);

    // Em Brasília, o atendimento (08:00–18:00) começa às 08:00 — e a consulta é marcada nesse horário.
    const first = await bookAppointment(page, clinic, ana.name, IN_THREE_DAYS);
    expect(first.slotLabel).toBe('08:00 – 08:50');
    await expect(appointmentRow(page, ana.name)).toContainText('08:00');
    await expect(page.getByRole('note')).toHaveCount(0);

    await openMenu(page, 'Configurações');
    const region = page.getByRole('region', { name: 'Fuso horário' });
    await expect(region).toContainText('Fuso atual: Brasília (São Paulo) — America/Sao_Paulo');
    await expect(region.getByRole('button', { name: 'Alterar fuso' })).toBeDisabled();

    await region.getByLabel('Novo fuso').selectOption('America/Manaus');
    await region.getByRole('button', { name: 'Alterar fuso' }).click();
    const dialog = page.getByRole('dialog', { name: 'Alterar o fuso da clínica?' });
    await expect(dialog).toContainText('De America/Sao_Paulo para America/Manaus');
    await expect(dialog).toContainText('Nada do que já foi gravado é reescrito');
    await dialog.getByRole('button', { name: 'Alterar fuso' }).click();

    await expect(region.getByRole('status')).toContainText('Fuso da clínica alterado para Manaus — America/Manaus.');
    await expect(region).toContainText('Fuso atual: Manaus — America/Manaus');

    // Lido de volta do servidor, não do estado da tela.
    await page.reload();
    await expect(page.getByRole('region', { name: 'Fuso horário' })).toContainText('Fuso atual: Manaus — America/Manaus');

    // A consulta já marcada continua no mesmo instante: 08:00 de Brasília é 07:00 de Manaus.
    await openMenu(page, 'Agenda');
    await expect(page.getByRole('note')).toContainText('Horários no fuso da clínica (America/Manaus)');
    await expect(appointmentRow(page, ana.name)).toContainText('07:00');
    await expect(appointmentRow(page, ana.name)).not.toContainText('08:00');

    // Daqui em diante o atendimento começa às 08:00 de Manaus — e é assim que o horário aparece, com o navegador em Brasília.
    const second = await bookAppointment(page, clinic, bruno.name, IN_FOUR_DAYS);
    expect(second.slotLabel).toBe('08:00 – 08:50');
    await expect(appointmentRow(page, bruno.name)).toContainText('08:00');

    // No dia da primeira consulta, as 08:00 de Manaus (09:00 de Brasília) continuam livres: ela ocupa as 07:00 de lá.
    await page.getByRole('button', { name: 'Nova consulta' }).click();
    const form = page.getByRole('form', { name: 'Nova consulta' });
    await form.locator('#appointment-therapist').selectOption({ label: clinic.therapist.name });
    await form.locator('#slot-day').fill(IN_THREE_DAYS);
    await expect(form.locator('#slot-time option').nth(1)).toHaveText('08:00 – 08:50');
  });

  test('o terapeuta vê o fuso da clínica e não tem como alterá-lo', async ({ page, clinic }) => {
    await signIn(page, clinic.therapistUser);
    await openMenu(page, 'Configurações');

    const region = page.getByRole('region', { name: 'Fuso horário' });
    await expect(region).toContainText('Fuso atual: Brasília (São Paulo) — America/Sao_Paulo');
    await expect(region).toContainText('Só um administrador pode alterar o fuso da clínica.');
    await expect(region.getByRole('combobox')).toHaveCount(0);
    await expect(region.getByRole('button')).toHaveCount(0);
  });
});
