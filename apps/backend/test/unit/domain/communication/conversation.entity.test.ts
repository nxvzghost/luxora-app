import { describe, it, expect } from 'vitest';
import { Conversation } from '@domain/communication/conversation.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('Conversation — ADR-0053, agregado de identidade (sem máquina de estados)', () => {
  it('nasce sem patientId quando não informado', () => {
    const conversation = Conversation.create({ id: 'c1', tenantId: TENANT_ID, phoneNumber: '+5541999990000' });
    expect(conversation.patientId).toBeNull();
  });

  it('nasce com patientId quando o número já corresponde a um Patient', () => {
    const conversation = Conversation.create({
      id: 'c1',
      tenantId: TENANT_ID,
      phoneNumber: '+5541999990000',
      patientId: 'p1',
    });
    expect(conversation.patientId).toBe('p1');
  });

  it('addMessage registra a Message pendente e o evento de domínio correspondente', () => {
    const conversation = Conversation.create({ id: 'c1', tenantId: TENANT_ID, phoneNumber: '+5541999990000' });

    const message = conversation.addMessage({ id: 'm1', direction: 'entrada', content: 'Olá', externalId: 'wamid.1' });

    expect(message.direction).toBe('entrada');
    expect(message.externalId).toBe('wamid.1');

    const pending = conversation.pullPendingMessages();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('m1');

    const events = conversation.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('MensagemRegistrada');
  });

  it('pullPendingMessages()/pullDomainEvents() esvaziam a fila — nunca retornam a mesma Message duas vezes', () => {
    const conversation = Conversation.create({ id: 'c1', tenantId: TENANT_ID, phoneNumber: '+5541999990000' });
    conversation.addMessage({ id: 'm1', direction: 'entrada', content: 'Olá' });

    conversation.pullPendingMessages();
    conversation.pullDomainEvents();

    expect(conversation.pullPendingMessages()).toHaveLength(0);
    expect(conversation.pullDomainEvents()).toHaveLength(0);
  });

  it('mensagens de saída (resposta da IA) também são Messages, direction "saida"', () => {
    const conversation = Conversation.create({ id: 'c1', tenantId: TENANT_ID, phoneNumber: '+5541999990000' });
    const message = conversation.addMessage({ id: 'm2', direction: 'saida', content: 'Olá! Tudo bem?' });
    expect(message.direction).toBe('saida');
    expect(message.externalId).toBeNull(); // WAMID só existe em mensagens de entrada
  });
});
