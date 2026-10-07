'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { describeApiError } from '@/lib/api-client/errors';
import { useAuthStore } from '@/lib/stores/auth.store';
import { Button } from '@/components/ui/button';
import { ErrorMessage, SuccessMessage } from '@/components/ui/feedback';
import { cardStyle, hintStyle, inputStyle, labelStyle, sectionTitleStyle } from '@/components/ui/page-shell';

/**
 * WhatsAppConnection — Tarefa 05 da auditoria. Conecta o canal de WhatsApp
 * da clínica pela tela (POST /whatsapp/connect, só admin), que antes exigia
 * chamar a API direto.
 *
 * Só grava a credencial: nenhuma chamada à Meta acontece aqui, e a API não
 * valida o token nem informa depois se o canal está conectado.
 *
 * O token de acesso é um segredo. Fica só no estado deste formulário
 * enquanto é digitado, vai para o backend (que o guarda cifrado) e é
 * apagado da tela logo após o envio. Nunca vai para localStorage nem para o
 * cache de dados.
 */
export function WhatsAppConnection() {
  const token = useAuthStore((s) => s.accessToken);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: (input: { phoneNumberId: string; accessToken: string }) =>
      apiRequest<{ status: string }>('/whatsapp/connect', { method: 'POST', body: input, token }),
  });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);
    const id = phoneNumberId.trim();
    if (!/^\d+$/.test(id)) return setError('O identificador do número tem só dígitos. É o "Phone number ID" do painel da Meta, não o telefone.');
    setError(null);
    try {
      await connect.mutateAsync({ phoneNumberId: id, accessToken: accessToken.trim() });
      setSuccess('Canal gravado. As mensagens da clínica passam a sair por este número.');
      setPhoneNumberId('');
    } catch (err) {
      setError(describeApiError(err, 'Não foi possível gravar a conexão do WhatsApp.'));
    } finally {
      // Com sucesso ou com erro, o segredo não fica parado na tela.
      setAccessToken('');
    }
  }

  return (
    <section style={cardStyle} aria-label="WhatsApp">
      <h2 style={sectionTitleStyle}>WhatsApp da clínica</h2>
      <p style={{ ...hintStyle, marginTop: 0 }}>
        Número oficial (WhatsApp Business) por onde saem as cobranças e os avisos. Os dois dados vêm do painel da Meta, em Configuração da API.
        Gravar de novo substitui a conexão anterior.
      </p>
      <form onSubmit={handleSubmit} aria-label="Conectar WhatsApp">
        <label style={labelStyle} htmlFor="whatsapp-phone-number-id">
          Identificador do número (Phone number ID)
        </label>
        <input id="whatsapp-phone-number-id" required inputMode="numeric" autoComplete="off" value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} style={inputStyle} />

        <label style={labelStyle} htmlFor="whatsapp-access-token">
          Token de acesso
        </label>
        <input
          id="whatsapp-access-token"
          type="password"
          required
          autoComplete="off"
          value={accessToken}
          onChange={(event) => setAccessToken(event.target.value)}
          style={inputStyle}
        />
        <p style={hintStyle}>
          O token é guardado cifrado e não volta a ser exibido. Esta tela não confere o token com a Meta nem consegue mostrar se já existe um canal
          conectado — a API ainda não oferece essa consulta.
        </p>

        <ErrorMessage>{error}</ErrorMessage>
        <SuccessMessage>{success}</SuccessMessage>
        <Button type="submit" disabled={connect.isPending} style={{ marginTop: '0.75rem' }}>
          {connect.isPending ? 'Gravando...' : 'Conectar WhatsApp'}
        </Button>
      </form>
    </section>
  );
}
