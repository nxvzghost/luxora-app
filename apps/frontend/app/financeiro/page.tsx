'use client';

import { useState } from 'react';
import { PageShell, cardStyle, hintStyle, inputStyle, labelStyle, rowStyle, sectionTitleStyle } from '@/components/ui/page-shell';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, EmptyState, ErrorMessage, Loading, SuccessMessage } from '@/components/ui/feedback';
import { type Billing, useBillings, usePatients } from '@/lib/api-client/dashboard.hooks';
import {
  useBillableSessions,
  useBillingPayments,
  useCreateBilling,
  useRefundPayment,
  useRegisterPayment,
  useSendBilling,
} from '@/lib/api-client/billing.hooks';
import { useTherapists } from '@/lib/api-client/therapists.hooks';
import { describeApiError } from '@/lib/api-client/errors';
import { useRole } from '@/lib/session';
import { formatCurrencyBRL } from '@/lib/format-currency';

const STATE_LABELS: Record<string, string> = {
  Criada: 'Criada',
  Enviada: 'Enviada',
  Visualizada: 'Visualizada',
  Pendente: 'Pendente',
  Atrasada: 'Atrasada',
  Negociada: 'Negociada',
  Escalada: 'Escalada',
  Quitada: 'Quitada',
  Cancelada: 'Cancelada',
};

const STATE_COLORS: Record<string, string> = {
  Quitada: 'var(--success)',
  Atrasada: 'var(--danger)',
  Enviada: 'var(--gold-soft)',
  Pendente: 'var(--border)',
};

const PAYMENT_STATE_LABELS: Record<string, string> = {
  Recebido: 'Recebido',
  EmConferencia: 'Em conferência',
  Confirmado: 'Confirmado',
  Divergente: 'Divergente — o valor não bate com a cobrança',
  Estornado: 'Estornado',
};

/** Estados em que a cobrança ainda pode ser enviada ao paciente. */
const CAN_SEND = ['Criada'];

/**
 * Depois de um estorno a cobrança continua "Quitada" na API (ADR-0052: a
 * reversão da cobrança é uma decisão de produto ainda não tomada). Para a
 * clínica o que vale é o dinheiro: a tela mostra o estorno e não soma o
 * valor como recebido.
 */
const isRefunded = (billing: Billing) => billing.paymentState === 'Estornado';

/**
 * FinanceiroPage — Módulo 15; criar cobrança, acompanhar o pagamento e
 * estornar entraram na Tarefa 05 da auditoria (AD-020).
 *
 * As ações são só de admin, como na API; o terapeuta vê a lista.
 */
export default function FinanceiroPage() {
  const isAdmin = useRole() !== 'therapist';
  const { data: billingsData, isLoading, isError: errorBillings, error: billingsError } = useBillings();
  const { data: patientsData, isError: errorPatients, error: patientsError } = usePatients();
  const hasError = errorBillings || errorPatients;
  const sendBilling = useSendBilling();

  const [showCreate, setShowCreate] = useState(false);
  const [toSend, setToSend] = useState<Billing | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [paymentOf, setPaymentOf] = useState<Billing | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const patients = patientsData?.data ?? [];
  const billings = billingsData?.data ?? [];
  const patientName = (patientId: string) => patients.find((patient) => patient.id === patientId)?.name ?? 'Paciente';

  async function handleSend() {
    if (!toSend) return;
    setSendError(null);
    try {
      await sendBilling.mutateAsync(toSend.id);
      setSuccess(`Cobrança de ${patientName(toSend.patientId)} enviada para a fila do WhatsApp.`);
      setToSend(null);
    } catch (err) {
      setSendError(describeApiError(err, 'Não foi possível enviar a cobrança.'));
    }
  }

  const total = billings.reduce((sum, billing) => sum + billing.amount, 0);
  const received = billings.filter((billing) => billing.state === 'Quitada' && !isRefunded(billing)).reduce((sum, billing) => sum + billing.amount, 0);
  const overdue = billings.filter((billing) => billing.state === 'Atrasada').length;

  return (
    <PageShell
      title="Financeiro"
      actions={
        isAdmin && (
          <Button
            onClick={() => {
              setSuccess(null);
              setShowCreate((visible) => !visible);
            }}
          >
            {showCreate ? 'Fechar' : 'Nova cobrança'}
          </Button>
        )
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
        <StatCard label="Total faturado" value={formatCurrencyBRL(total)} tone="gold" />
        <StatCard label="Recebido" value={formatCurrencyBRL(received)} />
        <StatCard label="Cobranças em atraso" value={overdue} />
      </div>

      {showCreate && (
        <BillingForm
          patients={patients}
          onCreated={(billing) => {
            setShowCreate(false);
            setSuccess(`Cobrança de ${formatCurrencyBRL(billing.amount)} criada para ${patientName(billing.patientId)}.`);
          }}
        />
      )}

      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 500 }}>Cobranças</h2>

      {isLoading && <Loading />}
      {hasError && <ErrorMessage>{describeApiError(billingsError ?? patientsError, 'Não foi possível carregar os dados financeiros.')}</ErrorMessage>}
      {!isLoading && !hasError && billings.length === 0 && (
        <EmptyState>Nenhuma cobrança gerada ainda. Uma cobrança nasce das sessões realizadas: confirme a consulta na Agenda e depois crie a cobrança aqui.</EmptyState>
      )}
      <SuccessMessage>{success}</SuccessMessage>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {billings.map((billing) => (
          <li key={billing.id} style={rowStyle}>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{patientName(billing.patientId)}</p>
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>Vencimento: {new Date(billing.dueDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ margin: '0 0 0.25rem', fontWeight: 700 }}>{formatCurrencyBRL(billing.amount)}</p>
              <span
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  padding: '0.2rem 0.5rem',
                  borderRadius: '999px',
                  background: isRefunded(billing) ? 'var(--danger)' : (STATE_COLORS[billing.state] ?? 'var(--border)'),
                  color: billing.state === 'Quitada' || billing.state === 'Atrasada' ? '#fff' : 'var(--forest-ink)',
                }}
              >
                {isRefunded(billing) ? 'Pagamento estornado' : (STATE_LABELS[billing.state] ?? billing.state)}
              </span>
              {billing.paymentState === 'Divergente' && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--danger)' }}>Pagamento divergente</p>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {isAdmin && CAN_SEND.includes(billing.state) && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSuccess(null);
                    setSendError(null);
                    setToSend(billing);
                  }}
                >
                  Enviar
                </Button>
              )}
              {billing.state !== 'Cancelada' && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSuccess(null);
                    setPaymentOf(billing);
                  }}
                >
                  Pagamento
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {toSend && (
        <ConfirmDialog
          title="Enviar esta cobrança ao paciente?"
          description={
            <>
              {patientName(toSend.patientId)} recebe pelo WhatsApp da clínica a cobrança de {formatCurrencyBRL(toSend.amount)}, com a chave PIX das
              Configurações. A mensagem entra na fila de envio e não pode ser recolhida.
            </>
          }
          confirmLabel="Enviar cobrança"
          busyLabel="Enviando..."
          busy={sendBilling.isPending}
          error={sendError}
          onConfirm={handleSend}
          onCancel={() => setToSend(null)}
        />
      )}

      {paymentOf && (
        <PaymentDialog
          billing={paymentOf}
          patientName={patientName(paymentOf.patientId)}
          canAct={isAdmin}
          onClose={() => setPaymentOf(null)}
          onDone={(message) => {
            setPaymentOf(null);
            setSuccess(message);
          }}
        />
      )}
    </PageShell>
  );
}

function BillingForm(props: { patients: Array<{ id: string; name: string }>; onCreated: (billing: Billing) => void }) {
  const createBilling = useCreateBilling();
  const { data: therapistsData } = useTherapists();
  const [patientId, setPatientId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data: sessionsData, isLoading: loadingSessions, isError: sessionsFailed, error: sessionsError } = useBillableSessions(patientId);
  const sessions = sessionsData?.data ?? [];
  const therapistName = (id: string) => therapistsData?.data.find((therapist) => therapist.id === id)?.name ?? 'Terapeuta';

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const value = Number(amount.replace(',', '.'));
    if (selected.length === 0) return setError('Marque ao menos uma sessão para cobrar.');
    if (!Number.isFinite(value) || value <= 0) return setError('Informe um valor maior que zero.');
    setError(null);
    try {
      props.onCreated(await createBilling.mutateAsync({ patientId, amount: value, dueDate, sessionIds: selected }));
    } catch (err) {
      // Outra pessoa pode ter cobrado a mesma sessão nesse meio-tempo: a lista é recarregada pelo hook.
      setSelected([]);
      setError(describeApiError(err, 'Não foi possível criar a cobrança.'));
    }
  }

  return (
    <form onSubmit={handleSubmit} style={cardStyle} aria-label="Nova cobrança">
      <h2 style={sectionTitleStyle}>Nova cobrança</h2>

      <label style={labelStyle} htmlFor="billing-patient">
        Paciente
      </label>
      <select
        id="billing-patient"
        required
        value={patientId}
        onChange={(event) => {
          setPatientId(event.target.value);
          setSelected([]);
        }}
        style={inputStyle}
      >
        <option value="">Selecione...</option>
        {props.patients.map((patient) => (
          <option key={patient.id} value={patient.id}>
            {patient.name}
          </option>
        ))}
      </select>

      {patientId && (
        <fieldset style={{ border: 'none', padding: 0, margin: '0.875rem 0 0' }}>
          <legend style={{ ...labelStyle, marginTop: 0 }}>Sessões a cobrar</legend>
          {loadingSessions && <Loading>Buscando sessões...</Loading>}
          {sessionsFailed && <ErrorMessage>{describeApiError(sessionsError, 'Não foi possível buscar as sessões deste paciente.')}</ErrorMessage>}
          {!loadingSessions && !sessionsFailed && sessions.length === 0 && (
            <p style={hintStyle}>Este paciente não tem sessão a cobrar. Uma sessão aparece aqui depois que a consulta é confirmada na Agenda.</p>
          )}
          {sessions.map((session) => (
            <label key={session.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.25rem 0', fontSize: '0.9375rem' }}>
              <input
                type="checkbox"
                checked={selected.includes(session.id)}
                onChange={(event) => setSelected((current) => (event.target.checked ? [...current, session.id] : current.filter((id) => id !== session.id)))}
              />
              {new Date(session.scheduledAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} ·{' '}
              {therapistName(session.therapistId)}
            </label>
          ))}
        </fieldset>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <div>
          <label style={labelStyle} htmlFor="billing-amount">
            Valor total (R$)
          </label>
          <input id="billing-amount" inputMode="decimal" required placeholder="Ex.: 250,00" value={amount} onChange={(event) => setAmount(event.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle} htmlFor="billing-due">
            Vencimento
          </label>
          <input id="billing-due" type="date" required value={dueDate} onChange={(event) => setDueDate(event.target.value)} style={inputStyle} />
        </div>
      </div>

      <ErrorMessage>{error}</ErrorMessage>
      <Button type="submit" disabled={createBilling.isPending} style={{ marginTop: '1rem' }}>
        {createBilling.isPending ? 'Criando...' : 'Criar cobrança'}
      </Button>
    </form>
  );
}

/**
 * Pagamento de uma cobrança: registrar quando ainda não há, acompanhar o
 * estado quando há e estornar quando está confirmado. O estorno tem um
 * segundo passo de confirmação dentro da própria janela.
 */
function PaymentDialog(props: { billing: Billing; patientName: string; canAct: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const { data, isLoading, isError, error: loadError } = useBillingPayments(props.billing.id);
  const registerPayment = useRegisterPayment();
  const refundPayment = useRefundPayment();
  const [amount, setAmount] = useState(String(props.billing.amount).replace('.', ','));
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [confirmingRefund, setConfirmingRefund] = useState(false);
  const [confirmingDivergent, setConfirmingDivergent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payment = data?.data[0] ?? null;
  const busy = registerPayment.isPending || refundPayment.isPending;
  const canRegister = props.canAct && !isLoading && !isError && !payment && props.billing.state !== 'Quitada';
  const canRefund = props.canAct && payment?.state === 'Confirmado';

  async function handleConfirm() {
    setError(null);
    if (canRegister) {
      const value = Number(amount.replace(',', '.'));
      if (!Number.isFinite(value) || value <= 0) return setError('Informe o valor recebido, maior que zero.');
      // Um pagamento divergente não tem correção pela API nem pelo painel: pede um segundo passo, como o estorno.
      if (Math.abs(value - props.billing.amount) > 0.01 && !confirmingDivergent) return setConfirmingDivergent(true);
      try {
        const registered = await registerPayment.mutateAsync({ billingId: props.billing.id, amount: value, idempotencyKey });
        props.onDone(
          registered.state === 'Confirmado'
            ? `Pagamento de ${props.patientName} registrado. A cobrança foi quitada.`
            : `Pagamento de ${props.patientName} registrado como divergente: o valor não bate com a cobrança, que continua em aberto. Confira em Notificações.`,
        );
      } catch (err) {
        setError(describeApiError(err, 'Não foi possível registrar o pagamento.'));
      }
      return;
    }
    if (canRefund && payment) {
      if (!confirmingRefund) return setConfirmingRefund(true);
      try {
        await refundPayment.mutateAsync(payment.id);
        props.onDone(`Pagamento de ${props.patientName} estornado.`);
      } catch (err) {
        setError(describeApiError(err, 'Não foi possível estornar o pagamento.'));
      }
      return;
    }
    props.onClose();
  }

  const registerLabel = confirmingDivergent ? 'Registrar como divergente' : 'Registrar pagamento';
  const confirmLabel = canRegister ? registerLabel : canRefund ? (confirmingRefund ? 'Confirmar estorno' : 'Estornar pagamento') : 'Fechar';

  return (
    <ConfirmDialog
      title={`Pagamento — ${props.patientName}`}
      description={<>Cobrança de {formatCurrencyBRL(props.billing.amount)}.</>}
      confirmLabel={confirmLabel}
      busyLabel={refundPayment.isPending ? 'Estornando...' : 'Registrando...'}
      busy={busy}
      error={error}
      onConfirm={handleConfirm}
      onCancel={props.onClose}
    >
      {isLoading && <Loading>Buscando o pagamento...</Loading>}
      {isError && <ErrorMessage>{describeApiError(loadError, 'Não foi possível consultar o pagamento desta cobrança.')}</ErrorMessage>}

      {payment && (
        <p style={{ margin: '0.75rem 0 0', fontSize: '0.9375rem' }}>
          Pagamento de <strong>{formatCurrencyBRL(payment.amount)}</strong> — {PAYMENT_STATE_LABELS[payment.state] ?? payment.state}.
        </p>
      )}
      {!isLoading && !isError && !payment && !canRegister && <p style={{ ...hintStyle, marginTop: '0.75rem' }}>Nenhum pagamento registrado para esta cobrança.</p>}

      {canRegister && (
        <>
          <label style={labelStyle} htmlFor="payment-amount">
            Valor recebido (R$)
          </label>
          <input
            id="payment-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setConfirmingDivergent(false);
            }}
            style={inputStyle}
          />
          <p style={hintStyle}>Se o valor for diferente do da cobrança, o pagamento fica como divergente e a cobrança não é quitada.</p>
        </>
      )}

      {canRegister && confirmingDivergent && (
        <p role="alert" style={{ margin: '0.75rem 0 0', fontSize: '0.875rem', color: 'var(--danger)' }}>
          O valor informado é diferente do da cobrança ({formatCurrencyBRL(props.billing.amount)}). O pagamento será registrado como divergente, a
          cobrança continua em aberto e não aceita outro pagamento — isso não pode ser corrigido pelo painel. Confira o valor antes de confirmar.
        </p>
      )}

      {canRefund && confirmingRefund && (
        <p role="alert" style={{ margin: '0.75rem 0 0', fontSize: '0.875rem', color: 'var(--danger)' }}>
          O pagamento passa a constar como estornado e isso não pode ser desfeito. O valor sai do total recebido e a cobrança aparece como
          &quot;Pagamento estornado&quot;: ela não volta a ficar em aberto nem aceita outro pagamento.
        </p>
      )}
      {payment && !props.canAct && <p style={{ ...hintStyle, marginTop: '0.75rem' }}>Só um administrador registra ou estorna pagamentos.</p>}
    </ConfirmDialog>
  );
}
