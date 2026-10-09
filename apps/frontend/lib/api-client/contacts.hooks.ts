'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';

/**
 * contacts.hooks — ADR-0063 (AD-038). As duas rotas com que a clínica
 * aprova o vínculo de um número novo de WhatsApp a um paciente que já
 * existe. As duas são só de admin, na API.
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts-pending'] }),
  });
}
