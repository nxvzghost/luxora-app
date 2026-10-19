'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * contacts.hooks — ADR-0063 (AD-038). As rotas com que a clínica aprova o
 * vínculo de um número novo de WhatsApp a um paciente que já existe e, desde
 * a A-10 (19/10/2026), desfaz um vínculo aprovado. Todas só de admin, na API.
 */
export interface PendingContact {
  id: string;
  phoneNumber: string;
  /** O nome que a pessoa informou na conversa, se informou. Ninguém o conferiu. */
  name: string | null;
  state: string;
  createdAt: string;
}

export interface ContactLink {
  contactId: string;
  patientId: string;
  state: string;
  approvedByUserId: string;
  approvedAt: string;
}

/** A-10 — número que identifica um paciente porque a clínica aprovou o vínculo. */
export interface LinkedContact {
  contactId: string;
  phoneNumber: string;
  patientId: string;
  patientName: string;
  linkedAt: string;
}

export interface ContactUnlink {
  contactId: string;
  patientId: string;
  state: string;
  undoneByUserId: string;
  undoneAt: string;
}

/** Números que escreveram para a clínica e ainda não identificam nenhum paciente. */
export function usePendingContacts(enabled = true) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['contacts-pending'],
    queryFn: () => apiRequest<{ data: PendingContact[] }>('/contacts/pending', { token }),
    enabled: !!token && enabled,
  });
}

/** Aprova o vínculo: dali em diante, o número identifica o paciente no WhatsApp. */
export function useLinkContact() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contactId: string; patientId: string }) =>
      apiRequest<ContactLink>(`/contacts/${input.contactId}/link`, { method: 'POST', body: { patientId: input.patientId }, token }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contacts-pending'] });
      void queryClient.invalidateQueries({ queryKey: ['contacts-linked'] });
    },
  });
}

/** A-10 — vínculos aprovados pela clínica (os números do próprio cadastro ficam de fora). */
export function useLinkedContacts(enabled = true) {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['contacts-linked'],
    queryFn: () => apiRequest<{ data: LinkedContact[] }>('/contacts/linked', { token }),
    enabled: !!token && enabled,
  });
}

/** A-10 — desfaz um vínculo aprovado: o número deixa de identificar o paciente e volta a aguardar vínculo. */
export function useUnlinkContact() {
  const token = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contactId: string; patientId: string }) =>
      apiRequest<ContactUnlink>(`/contacts/${input.contactId}/unlink`, { method: 'POST', body: { patientId: input.patientId }, token }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contacts-linked'] });
      void queryClient.invalidateQueries({ queryKey: ['contacts-pending'] });
    },
  });
}
