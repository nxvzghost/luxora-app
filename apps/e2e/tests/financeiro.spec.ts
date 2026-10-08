import { billingRow, bookAndConfirm, clinicDate, createBilling, expect, openMenu, signIn, statCard, test } from '../support/fixtures';

/**
 * Ciclo financeiro pela tela — cobrança a partir da sessão realizada,
 * pagamento, valores e estados, atraso, pagamento divergente com a
 * notificação que ele gera, e estorno.
 *
 * Nenhum destes testes conecta o WhatsApp: o envio real da cobrança não é
 * exercitado aqui (ver "enviar sem WhatsApp conectado").
 */
const TOMORROW = clinicDate(1);
const NEXT_MONTH = clinicDate(30);
const LAST_WEEK = clinicDate(-7);

test.describe('Cobrança e pagamento', () => {
  test('cria a cobrança da sessão, registra o pagamento e os valores fecham no Financeiro e no Dashboard', async ({ page, clinicWithHours: clinic }) => {
    const [ana] = clinic.patients;
    await signIn(page, clinic.admin);
    await bookAndConfirm(page, clinic, ana.name, TOMORROW);

    await createBilling(page, ana.name, '250,00', NEXT_MONTH);
    const row = billingRow(page, ana.name);
    await expect(row).toContainText('R$ 250,00');
    await expect(row).toContainText('Criada');
    await expect(statCard(page, 'Total faturado')).toContainText('R$ 250,00');
    await expect(statCard(page, 'Recebido')).toContainText('R$ 0,00');
    await expect(statCard(page, 'Cobranças em atraso')).toContainText('0');

    // A sessão já cobrada não pode entrar em outra cobrança.
    await page.getByRole('button', { name: 'Nova cobrança' }).click();
    const form = page.getByRole('form', { name: 'Nova cobrança' });
    await form.locator('#billing-patient').selectOption({ label: ana.name });
    await expect(form).toContainText('não tem sessão a cobrar');
    await page.getByRole('button', { name: 'Fechar' }).click();

    await row.getByRole('button', { name: 'Pagamento' }).click();
    const dialog = page.getByRole('dialog', { name: `Pagamento — ${ana.name}` });
    await expect(dialog.locator('#payment-amount')).toHaveValue('250');
    await dialog.getByRole('button', { name: 'Registrar pagamento' }).click();

    await expect(page.getByRole('status')).toContainText('A cobrança foi quitada');
    await expect(row).toContainText('Quitada');
    await expect(statCard(page, 'Recebido')).toContainText('R$ 250,00');

    await openMenu(page, 'Dashboard');
    await expect(statCard(page, 'Total a receber')).toContainText('R$ 0,00');
    await expect(statCard(page, 'Cobranças em atraso')).toContainText('0');
  });

  test('cobrança vencida aparece em atraso no Financeiro e no Dashboard; paga, sai da contagem', async ({ page, clinicWithHours: clinic }) => {
    const [ana, bruno] = clinic.patients;
    await signIn(page, clinic.admin);
    await bookAndConfirm(page, clinic, ana.name, TOMORROW);
    await bookAndConfirm(page, clinic, bruno.name, TOMORROW);

    await createBilling(page, ana.name, '180,00', LAST_WEEK);
    await createBilling(page, bruno.name, '120,00', NEXT_MONTH);

    await expect(statCard(page, 'Cobranças em atraso')).toContainText('1');
    await expect(billingRow(page, ana.name)).toContainText('Em atraso');
    await expect(billingRow(page, bruno.name)).not.toContainText('Em atraso');

    await openMenu(page, 'Dashboard');
    await expect(statCard(page, 'Cobranças em atraso')).toContainText('1');
    await expect(statCard(page, 'Total a receber')).toContainText('R$ 300,00');

    await openMenu(page, 'Financeiro');
    await billingRow(page, ana.name).getByRole('button', { name: 'Pagamento' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Registrar pagamento' }).click();
    await expect(page.getByRole('status')).toContainText('A cobrança foi quitada');

    // Quitada, com o mesmo vencimento antigo: não está mais em atraso.
    await expect(billingRow(page, ana.name)).toContainText('Quitada');
    await expect(billingRow(page, ana.name)).not.toContainText('Em atraso');
    await expect(statCard(page, 'Cobranças em atraso')).toContainText('0');

    await openMenu(page, 'Dashboard');
    await expect(statCard(page, 'Cobranças em atraso')).toContainText('0');
    await expect(statCard(page, 'Total a receber')).toContainText('R$ 120,00');
  });

  test('enviar sem WhatsApp conectado é recusado e a cobrança continua Criada', async ({ page, clinicWithHours: clinic }) => {
    const [ana] = clinic.patients;
    await signIn(page, clinic.admin);
    await bookAndConfirm(page, clinic, ana.name, TOMORROW);
    await createBilling(page, ana.name, '200,00', NEXT_MONTH);
    const row = billingRow(page, ana.name);

    await row.getByRole('button', { name: 'Enviar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Enviar esta cobrança ao paciente?' });
    await dialog.getByRole('button', { name: 'Enviar cobrança' }).click();

    await expect(dialog.getByRole('alert')).toContainText('nada foi enviado');
    await dialog.getByRole('button', { name: 'Voltar' }).click();
    await expect(row).toContainText('Criada');
    await expect(row.getByRole('button', { name: 'Enviar' })).toBeVisible();
  });

  test('perfil terapeuta consulta o financeiro, sem as ações do administrador', async ({ page, clinicWithHours: clinic }) => {
    const [ana] = clinic.patients;
    await signIn(page, clinic.admin);
    await bookAndConfirm(page, clinic, ana.name, TOMORROW);
    await createBilling(page, ana.name, '200,00', NEXT_MONTH);
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await signIn(page, clinic.therapistUser);
    await openMenu(page, 'Financeiro');

    const row = billingRow(page, ana.name);
    await expect(row).toContainText('R$ 200,00');
    await expect(page.getByRole('button', { name: 'Nova cobrança' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Enviar' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Pagamento' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Registrar pagamento' })).toHaveCount(0);
  });
});

test.describe('Pagamento divergente e notificação', () => {
  test('valor diferente pede um segundo passo, deixa a cobrança em aberto e gera a notificação', async ({ page, clinicWithHours: clinic }) => {
    const [ana] = clinic.patients;
    await signIn(page, clinic.admin);
    await bookAndConfirm(page, clinic, ana.name, TOMORROW);
    await createBilling(page, ana.name, '180,00', NEXT_MONTH);
    const row = billingRow(page, ana.name);

    await row.getByRole('button', { name: 'Pagamento' }).click();
    const dialog = page.getByRole('dialog', { name: `Pagamento — ${ana.name}` });
    await dialog.locator('#payment-amount').fill('150,00');
    await dialog.getByRole('button', { name: 'Registrar pagamento' }).click();

    // Primeiro clique só avisa; nada foi gravado ainda.
    await expect(dialog.getByRole('alert')).toContainText('diferente do da cobrança');
    await dialog.getByRole('button', { name: 'Registrar como divergente' }).click();

    await expect(page.getByRole('status')).toContainText('registrado como divergente');
    await expect(row).toContainText('Criada');
    await expect(row).toContainText('Pagamento divergente');
    await expect(statCard(page, 'Recebido')).toContainText('R$ 0,00');

    // A notificação aparece no menu e na tela, e pode ser marcada como lida.
    const menu = page.getByRole('navigation', { name: 'Principal' });
    await expect(menu.getByLabel('1 não lida')).toBeVisible();
    await openMenu(page, 'Notificações');
    const notification = page.getByRole('listitem').filter({ hasText: 'Pagamento divergente' });
    await expect(notification).toHaveCount(1);
    await notification.getByRole('button', { name: 'Marcar como lida' }).click();
    await expect(notification).toContainText('lida');
    await expect(menu.getByLabel('1 não lida')).toHaveCount(0);
  });

  test('clínica sem notificações mostra a tela vazia', async ({ page, clinic }) => {
    await signIn(page, clinic.admin);
    await openMenu(page, 'Notificações');

    await expect(page.getByText('Nenhuma notificação')).toBeVisible();
  });
});

test.describe('Estorno', () => {
  test('estorna em dois passos; o valor sai do recebido e a cobrança mostra o estorno', async ({ page, clinicWithHours: clinic }) => {
    const [ana] = clinic.patients;
    await signIn(page, clinic.admin);
    await bookAndConfirm(page, clinic, ana.name, TOMORROW);
    await createBilling(page, ana.name, '250,00', NEXT_MONTH);
    const row = billingRow(page, ana.name);
    await row.getByRole('button', { name: 'Pagamento' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Registrar pagamento' }).click();
    await expect(statCard(page, 'Recebido')).toContainText('R$ 250,00');

    await row.getByRole('button', { name: 'Pagamento' }).click();
    const dialog = page.getByRole('dialog', { name: `Pagamento — ${ana.name}` });
    await expect(dialog).toContainText('Confirmado');
    await dialog.getByRole('button', { name: 'Estornar pagamento' }).click();
    // Primeiro clique só explica o efeito.
    await expect(dialog.getByRole('alert')).toContainText('não pode ser desfeito');
    await expect(row).toContainText('Quitada');
    await dialog.getByRole('button', { name: 'Confirmar estorno' }).click();

    await expect(page.getByRole('status')).toContainText('estornado');
    await expect(row).toContainText('Pagamento estornado');
    await expect(statCard(page, 'Recebido')).toContainText('R$ 0,00');
    await expect(statCard(page, 'Total faturado')).toContainText('R$ 250,00');

    // Depois do estorno não há mais ação sobre o pagamento.
    await row.getByRole('button', { name: 'Pagamento' }).click();
    await expect(page.getByRole('dialog')).toContainText('Estornado');
    await expect(page.getByRole('dialog').getByRole('button', { name: /estornar/i })).toHaveCount(0);
  });
});
