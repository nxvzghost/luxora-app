'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, ErrorMessage, Loading, SuccessMessage } from '@/components/ui/feedback';
import { cardStyle, hintStyle, inputStyle, rowStyle, sectionTitleStyle } from '@/components/ui/page-shell';
import { describeApiError } from '@/lib/api-client/errors';
import { type PendingContact, useLinkContact, usePendingContacts } from '@/lib/api-client/contacts.hooks';
import type { Patient } from '@/lib/api-client/dashboard.hooks';

/**
 * PendingContactLinks — ADR-0063 (AD-038). Onde o administrador aprova o
 * vínculo de um número novo de WhatsApp a um paciente que já existe.
 *
 * O número só passa a identificar o paciente depois desta aprovação: o que
 * a pessoa disse na conversa, inclusive o nome mostrado aqui, não prova
 * nada. Por isso a aprovação pede uma confirmação à parte, que diz o que
 * muda, e a API grava quem aprovou e quando.
 */
export function PendingContactLinks({ patients }: { patients: Patient[] }) {
  const { data, isLoading, isError, error } = usePendingContacts();
  const linkContact = useLinkContact();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [toLink, setToLink] = useState<{ contact: PendingContact; patient: Patient } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const contacts = data?.data ?? [];

  async function handleConfirm() {
    if (!toLink) return;
    setDialogError(null);
    try {
      await linkContact.mutateAsync({ contactId: toLink.contact.id, patientId: toLink.patient.id });
      setSuccess(`O número ${toLink.contact.phoneNumber} agora identifica ${toLink.patient.name} no WhatsApp.`);
      setToLink(null);
    } catch (err) {
      setDialogError(describeApiError(err, 'Não foi possível aprovar o vínculo.'));
    }
  }

  return (
    <section aria-labelledby="pending-contact-links-title" style={cardStyle}>
      <h2 id="pending-contact-links-title" style={sectionTitleStyle}>
        Números aguardando vínculo
      </h2>
      <p style={{ ...hintStyle, marginBottom: '0.75rem' }}>
        Números que escreveram para a clínica pelo WhatsApp e não constam no cadastro de nenhum paciente. O nome é o que a pessoa
        informou na conversa — ninguém o conferiu. Vincule só depois de confirmar com o paciente, por outro meio, que o número é dele.
      </p>

      {isLoading && <Loading />}
      {isError && <ErrorMessage>{describeApiError(error, 'Não foi possível carregar os números aguardando vínculo.')}</ErrorMessage>}
      {!isLoading && !isError && contacts.length === 0 && <p style={hintStyle}>Nenhum número aguardando vínculo.</p>}
      <SuccessMessage>{success}</SuccessMessage>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {contacts.map((contact) => {
          const patient = patients.find((candidate) => candidate.id === chosen[contact.id]);
          return (
            <li key={contact.id} style={{ ...rowStyle, flexWrap: 'wrap' }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{contact.phoneNumber}</p>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>
                  {contact.name ? `Nome informado na conversa: ${contact.name}` : 'Não informou nome'}
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <select
                  aria-label={`Paciente para o número ${contact.phoneNumber}`}
                  value={chosen[contact.id] ?? ''}
                  onChange={(event) => setChosen((current) => ({ ...current, [contact.id]: event.target.value }))}
                  style={{ ...inputStyle, width: 'auto', maxWidth: '260px' }}
                >
                  <option value="">Escolha o paciente</option>
                  {patients.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name} — {candidate.phone}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  disabled={!patient}
                  onClick={() => {
                    if (!patient) return;
                    setSuccess(null);
                    setDialogError(null);
                    setToLink({ contact, patient });
                  }}
                >
                  Vincular
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {toLink && (
        <ConfirmDialog
          title="Aprovar o vínculo deste número?"
          description={
            <>
              O número <strong>{toLink.contact.phoneNumber}</strong> passará a identificar <strong>{toLink.patient.name}</strong> no
              WhatsApp: quem escrever dele poderá marcar e cancelar consultas e consultar cobranças em nome do paciente. Aprove só se a
              clínica já confirmou, por outro meio, que o número é dele. A aprovação fica registrada no seu usuário, com data e hora.
            </>
          }
          confirmLabel="Aprovar vínculo"
          busyLabel="Aprovando..."
          busy={linkContact.isPending}
          error={dialogError}
          onConfirm={handleConfirm}
          onCancel={() => setToLink(null)}
        />
      )}
    </section>
  );
}
