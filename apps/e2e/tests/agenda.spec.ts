import { appointmentRow, bookAppointment, clinicDate, expect, openMenu, signIn, test, weekdayOf } from '../support/fixtures';

/**
 * Disponibilidade e ciclo da consulta — definir horários, marcar,
 * confirmar, remarcar e cancelar, pela tela.
 */
const TOMORROW = clinicDate(1);

test.describe('Disponibilidade', () => {
  test('grava os horários de atendimento, lê de volta e a agenda passa a oferecê-los', async ({ page, clinic }) => {
    await signIn(page, clinic.admin);
    await openMenu(page, 'Disponibilidade');
    await page.locator('#availability-therapist').selectOption({ label: clinic.therapist.name });

    const form = page.getByRole('form', { name: 'Horários de atendimento' });
    await expect(form).toContainText('Nenhum horário definido');
    await form.getByRole('button', { name: 'Adicionar horário' }).click();
    await form.getByLabel('Dia').selectOption(String(weekdayOf(TOMORROW)));
    await form.getByLabel('Início').fill('09:00');
    await form.getByLabel('Fim').fill('12:00');
    await form.getByLabel('Sessão (min)').fill('50');
    await form.getByRole('button', { name: 'Salvar horários' }).click();

    await expect(form.getByRole('status')).toContainText('Horários de atendimento salvos');
    await expect(form).not.toContainText('Há alterações não salvas');
    // 09:00–12:00 em sessões de 50 minutos: três horários.
    await expect(page.getByRole('region', { name: 'Horários livres' })).toContainText('3 horários');

    // Lido de volta do servidor, não do estado da tela.
    await page.reload();
    await page.locator('#availability-therapist').selectOption({ label: clinic.therapist.name });
    const reloaded = page.getByRole('form', { name: 'Horários de atendimento' });
    await expect(reloaded.getByLabel('Início')).toHaveValue('09:00');
    await expect(reloaded.getByLabel('Fim')).toHaveValue('12:00');

    // E a Agenda oferece exatamente esses horários.
    await openMenu(page, 'Agenda');
    await page.getByRole('button', { name: 'Nova consulta' }).click();
    const booking = page.getByRole('form', { name: 'Nova consulta' });
    await booking.locator('#appointment-therapist').selectOption({ label: clinic.therapist.name });
    await booking.locator('#slot-day').fill(TOMORROW);
    await expect(booking.locator('#slot-time option')).toHaveText(['Selecione...', '09:00 – 09:50', '09:50 – 10:40', '10:40 – 11:30']);
  });

  test('terapeuta sem horários: a agenda não oferece nenhum e aponta o caminho', async ({ page, clinic }) => {
    await signIn(page, clinic.admin);
    await openMenu(page, 'Agenda');
    await page.getByRole('button', { name: 'Nova consulta' }).click();
    const booking = page.getByRole('form', { name: 'Nova consulta' });
    await booking.locator('#appointment-therapist').selectOption({ label: clinic.therapist.name });
    await booking.locator('#slot-day').fill(TOMORROW);

    await expect(booking.locator('#slot-time')).toHaveCount(0);
    await expect(booking.getByRole('link', { name: 'disponibilidade do terapeuta' })).toBeVisible();
  });
});

test.describe('Consulta', () => {
  test('marca e confirma; o horário ocupado deixa de ser oferecido', async ({ page, clinicWithHours: clinic }) => {
    const [ana, bruno] = clinic.patients;
    await signIn(page, clinic.admin);

    const { slotLabel } = await bookAppointment(page, clinic, ana.name, TOMORROW);
    const row = appointmentRow(page, ana.name);
    await expect(row).toContainText('Reservado');
    await expect(row).toContainText(clinic.therapist.name);

    await row.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByRole('status')).toContainText(`Consulta de ${ana.name} confirmada`);
    await expect(row).toContainText('Confirmado');
    await expect(row.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);

    // Outro paciente, mesmo terapeuta e dia: aquele horário não está mais na lista.
    await page.getByRole('button', { name: 'Nova consulta' }).click();
    const booking = page.getByRole('form', { name: 'Nova consulta' });
    await booking.locator('#appointment-patient').selectOption({ label: bruno.name });
    await booking.locator('#appointment-therapist').selectOption({ label: clinic.therapist.name });
    await booking.locator('#slot-day').fill(TOMORROW);
    await expect(booking.locator('#slot-time option').nth(1)).toBeAttached();
    await expect(booking.locator('#slot-time option', { hasText: slotLabel })).toHaveCount(0);
  });

  test('remarca para outro horário e a consulta volta a pedir confirmação', async ({ page, clinicWithHours: clinic }) => {
    const [ana] = clinic.patients;
    await signIn(page, clinic.admin);
    const { slotLabel } = await bookAppointment(page, clinic, ana.name, TOMORROW);
    const row = appointmentRow(page, ana.name);

    await row.getByRole('button', { name: 'Remarcar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remarcar consulta' });
    await dialog.locator('#slot-day').fill(TOMORROW);
    const slot = dialog.locator('#slot-time');
    // O horário atual da própria consulta não é oferecido de novo.
    await expect(slot.locator('option').nth(1)).toBeAttached();
    await expect(slot.locator('option', { hasText: slotLabel })).toHaveCount(0);
    const newLabel = (await slot.locator('option').nth(1).textContent()) ?? '';
    await slot.selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Remarcar' }).click();

    await expect(page.getByRole('status')).toContainText(`Consulta de ${ana.name} remarcada`);
    await expect(row).toContainText('Reagendado');
    await expect(row).toContainText(newLabel.slice(0, 5)); // hora de início do novo horário
    await expect(row.getByRole('button', { name: 'Confirmar' })).toBeVisible();
  });

  test('cancela com confirmação; a consulta sai da agenda e o horário volta a ficar livre', async ({ page, clinicWithHours: clinic }) => {
    const [ana, bruno] = clinic.patients;
    await signIn(page, clinic.admin);
    const { slotLabel } = await bookAppointment(page, clinic, ana.name, TOMORROW);
    const row = appointmentRow(page, ana.name);

    // Desistir no meio não cancela nada.
    await row.getByRole('button', { name: 'Cancelar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancelar esta consulta?' });
    await dialog.getByRole('button', { name: 'Voltar' }).click();
    await expect(row).toContainText('Reservado');

    await row.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('dialog', { name: 'Cancelar esta consulta?' }).getByRole('button', { name: 'Cancelar consulta' }).click();

    await expect(page.getByRole('status')).toContainText(`Consulta de ${ana.name} cancelada`);
    await expect(row).toHaveCount(0);

    await page.getByRole('button', { name: 'Nova consulta' }).click();
    const booking = page.getByRole('form', { name: 'Nova consulta' });
    await booking.locator('#appointment-patient').selectOption({ label: bruno.name });
    await booking.locator('#appointment-therapist').selectOption({ label: clinic.therapist.name });
    await booking.locator('#slot-day').fill(TOMORROW);
    await expect(booking.locator('#slot-time option', { hasText: slotLabel })).toHaveCount(1);
  });

  test('perfil terapeuta também marca e confirma consultas', async ({ page, clinicWithHours: clinic }) => {
    const [ana] = clinic.patients;
    await signIn(page, clinic.therapistUser);

    await bookAppointment(page, clinic, ana.name, TOMORROW);
    await appointmentRow(page, ana.name).getByRole('button', { name: 'Confirmar' }).click();

    await expect(appointmentRow(page, ana.name)).toContainText('Confirmado');
  });
});
