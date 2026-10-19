'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, ErrorMessage, Loading, SuccessMessage } from '@/components/ui/feedback';
import { cardStyle, hintStyle, rowStyle, sectionTitleStyle } from '@/components/ui/page-shell';
import { describeApiError } from '@/lib/api-client/errors';
import { type LinkedContact, useLinkedContacts, useUnlinkContact } from '@/lib/api-client/contacts.hooks';

/**
 * LinkedContacts — A-10 da auditoria (19/10/2026). Os números que
 * identificam um paciente porque a clínica aprovou o vínculo, e o botão para
 * desfazer um vínculo aprovado por engano. Até aqui isso só se corrigia no
 * banco.
 *
 * Desfazer também pede uma confirmação à parte, que diz o que muda; a API
 * grava quem desfez e quando. O número volta para a lista de números
 * aguardando vínculo, e a conversa não é apagada.
 */
export function LinkedContacts() {
  const { data, isLoading, isError, error } = useLinkedContacts();
  const unlinkContact = useUnlinkContact();
  const [toUnlink, setToUnlink] = useState<LinkedContact | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const links = data?.data ?? [];

  async function handleConfirm() {
    if (!toUnlink) return;
    setDialogError(null);
    try {
      await unlinkContact.mutateAsync({ contactId: toUnlink.contactId, patientId: toUnlink.patientId });
      setSuccess(`O número ${toUnlink.phoneNumber} não identifica mais ${toUnlink.patientName} no WhatsApp.`);
      setToUnlink(null);
    } catch (err) {
      setDialogError(describeApiError(err, 'Não foi possível desfazer o vínculo.'));
    }
  }

  return (
    <section aria-labelledby="linked-contacts-title" style={cardStyle}>
      <h2 id="linked-contacts-title" style={sectionTitleStyle}>
        Números vinculados
      </h2>
      <p style={{ ...hintStyle, marginBottom: '0.75rem' }}>
        Números que identificam um paciente no WhatsApp porque a clínica aprovou o vínculo. O número que está no cadastro do próprio
        paciente não aparece aqui: para ele, vale o telefone do cadastro.
      </p>

      {isLoading && <Loading />}
      {isError && <ErrorMessage>{describeApiError(error, 'Não foi possível carregar os números vinculados.')}</ErrorMessage>}
      {!isLoading && !isError && links.length === 0 && <p style={hintStyle}>Nenhum número vinculado por aprovação.</p>}
      <SuccessMessage>{success}</SuccessMessage>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {links.map((link) => (
          <li key={`${link.contactId}-${link.patientId}`} style={{ ...rowStyle, flexWrap: 'wrap' }}>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{link.phoneNumber}</p>
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>Identifica {link.patientName}</p>
            </div>
            <Button
              type="button"
              onClick={() => {
                setSuccess(null);
                setDialogError(null);
                setToUnlink(link);
              }}
            >
              Desfazer vínculo
            </Button>
          </li>
        ))}
      </ul>

      {toUnlink && (
        <ConfirmDialog
          title="Desfazer o vínculo deste número?"
          description={
            <>
              O número <strong>{toUnlink.phoneNumber}</strong> deixará de identificar <strong>{toUnlink.patientName}</strong> no WhatsApp:
              quem escrever dele não poderá mais marcar, cancelar nem consultar nada em nome do paciente. O número volta para a lista de
              números aguardando vínculo, e a conversa não é apagada. O registro fica no seu usuário, com data e hora.
            </>
          }
          confirmLabel="Desfazer o vínculo"
          busyLabel="Desfazendo..."
          busy={unlinkContact.isPending}
          error={dialogError}
          onConfirm={handleConfirm}
          onCancel={() => setToUnlink(null)}
        />
      )}
    </section>
  );
}
