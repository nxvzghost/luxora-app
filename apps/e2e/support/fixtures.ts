import { test as base, expect, type Page } from '@playwright/test';
import { createClinic, removeClinic, type TestClinic, type TestUser } from './database';

/**
 * Fixtures dos testes de ponta a ponta.
 *
 * `clinic` e `clinicWithHours` entregam uma clínica nova a cada teste e a
 * removem depois, mesmo quando o teste falha (o Playwright sempre executa a
 * parte depois de `use`). `clinicWithHours` já vem com horários de
 * atendimento, para os testes de agenda e cobrança não dependerem da tela
 * de Disponibilidade — que tem o seu próprio teste.
 */
export const test = base.extend<{ clinic: TestClinic; clinicWithHours: TestClinic }>({
  clinic: async ({}, use) => {
    const clinic = await createClinic();
    await use(clinic);
    await removeClinic(clinic.tenantId);
  },
  clinicWithHours: async ({}, use) => {
    const clinic = await createClinic({ withAvailability: true });
    await use(clinic);
    await removeClinic(clinic.tenantId);
  },
});

export { expect };

export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(user.email);
  await page.locator('input[type="password"]').fill(user.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/**
 * Navega pelo menu lateral, como a pessoa faz — não por endereço digitado.
 * O nome do link é comparado pelo começo: o de Notificações ganha o
 * contador de não lidas ("Notificações 1 não lida").
 */
export async function openMenu(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: new RegExp(`^${label}`) }).click();
  if (label === 'Dashboard') {
    // A tela inicial tem uma saudação no título, não o nome do menu.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('Pacientes ativos')).toBeVisible();
    return;
  }
  await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
}

/** Mensagem de erro da tela. O Next mantém um `role="alert"` próprio e vazio (anunciador de rota), que não é o que se quer ler. */
export function errorMessage(page: Page) {
  return page.locator('p[role="alert"]');
}

/** Data (AAAA-MM-DD) no fuso da clínica, `offsetDays` dias a partir de hoje. */
export function clinicDate(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Dia da semana (0 = domingo) de uma data AAAA-MM-DD. */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

export interface BookedAppointment {
  /** Rótulo do horário escolhido, como aparece no seletor (ex.: "08:00 – 08:50"). */
  slotLabel: string;
}

/**
 * Marca uma consulta pela tela da Agenda, no primeiro horário livre do dia.
 * Deixa a página na Agenda, com a consulta listada.
 */
export async function bookAppointment(page: Page, clinic: TestClinic, patientName: string, day: string): Promise<BookedAppointment> {
  await openMenu(page, 'Agenda');
  await page.getByRole('button', { name: 'Nova consulta' }).click();
  const form = page.getByRole('form', { name: 'Nova consulta' });
  await form.locator('#appointment-patient').selectOption({ label: patientName });
  await form.locator('#appointment-therapist').selectOption({ label: clinic.therapist.name });
  await form.locator('#slot-day').fill(day);

  const slot = form.locator('#slot-time');
  await expect(slot.locator('option')).not.toHaveCount(1); // além do "Selecione..."
  const slotLabel = (await slot.locator('option').nth(1).textContent()) ?? '';
  await slot.selectOption({ index: 1 });
  await form.getByRole('button', { name: 'Marcar consulta' }).click();

  await expect(page.getByRole('status')).toContainText(`Consulta de ${patientName} marcada`);
  return { slotLabel };
}

/** Linha da consulta de um paciente na lista da Agenda. */
export function appointmentRow(page: Page, patientName: string) {
  return page.getByRole('listitem').filter({ hasText: patientName });
}

/** Marca e confirma: é a confirmação que gera a sessão a cobrar. */
export async function bookAndConfirm(page: Page, clinic: TestClinic, patientName: string, day: string): Promise<void> {
  await bookAppointment(page, clinic, patientName, day);
  await appointmentRow(page, patientName).getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByRole('status')).toContainText(`Consulta de ${patientName} confirmada`);
  await expect(appointmentRow(page, patientName)).toContainText('Confirmado');
}

/** Cria, pela tela do Financeiro, a cobrança da única sessão a cobrar do paciente. */
export async function createBilling(page: Page, patientName: string, amount: string, dueDate: string): Promise<void> {
  await openMenu(page, 'Financeiro');
  await page.getByRole('button', { name: 'Nova cobrança' }).click();
  const form = page.getByRole('form', { name: 'Nova cobrança' });
  await form.locator('#billing-patient').selectOption({ label: patientName });
  await form.getByRole('checkbox').check();
  await form.locator('#billing-amount').fill(amount);
  await form.locator('#billing-due').fill(dueDate);
  await form.getByRole('button', { name: 'Criar cobrança' }).click();
  await expect(page.getByRole('status')).toContainText(`criada para ${patientName}`);
}

/** Linha da cobrança de um paciente na lista do Financeiro. */
export function billingRow(page: Page, patientName: string) {
  return page.getByRole('listitem').filter({ hasText: patientName });
}

/** Cartão de indicador (Financeiro ou Dashboard) pelo rótulo. */
export function statCard(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator('..');
}
