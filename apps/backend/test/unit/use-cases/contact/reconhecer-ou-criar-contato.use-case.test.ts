import { describe, it, expect, vi } from 'vitest';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { Contact } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function makeDeps(opts: { existingContact?: Contact | null } = {}) {
  const contactRepo = {
    findByTenantAndPhone: vi.fn().mockResolvedValue(opts.existingContact ?? null),
    findById: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    saveAssociation: vi.fn(),
    findAssociationsByContactId: vi.fn(),
  };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };

  const useCase = new ReconhecerOuCriarContatoUseCase(contactRepo as never, auditService as never);

  return { useCase, contactRepo, auditService };
}

describe('ReconhecerOuCriarContatoUseCase — ADR-0055 (AD-018), Fase 4', () => {
  it('cria um Contact novo quando nenhum existe para o telefone, já em Conversando (interagir aplicado)', async () => {
    const { useCase, contactRepo, auditService } = makeDeps({ existingContact: null });

    const contact = await useCase.execute(TENANT_ID, '11988887777');

    expect(contact.state).toBe('Conversando');
    expect(contact.tenantId).toBe(TENANT_ID);
    expect(contact.phoneNumber?.toE164()).toBe('+5511988887777');
    expect(contactRepo.save).toHaveBeenCalledWith(contact);
    // Contact.create() (caminho normal, Cenário 1) não emite ContatoCriado —
    // só createAlreadyLinked() (Cenário 14) emite; interagir() é o único
    // evento real desta primeira mensagem.
    expect(auditService.recordAll).toHaveBeenCalledWith([expect.objectContaining({ eventName: 'ContatoInteragiu' })], 'system');
  });

  it('normaliza o telefone (formatação humana) antes de buscar — mesmo Contact para variações de escrita', async () => {
    const { useCase, contactRepo } = makeDeps({ existingContact: null });

    await useCase.execute(TENANT_ID, '(11) 98888-7777');

    expect(contactRepo.findByTenantAndPhone).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ toE164: expect.any(Function) }),
    );
    const [, phoneArg] = contactRepo.findByTenantAndPhone.mock.calls[0] as [string, PhoneNumber];
    expect(phoneArg.toE164()).toBe('+5511988887777');
  });

  it('reconhece um Contact existente em Novo e avança para Conversando', async () => {
    const existing = Contact.reconstitute({
      id: 'c1',
      tenantId: TENANT_ID,
      phoneNumber: PhoneNumber.normalize('11988887777'),
      state: 'Novo',
    });
    const { useCase, contactRepo, auditService } = makeDeps({ existingContact: existing });

    const contact = await useCase.execute(TENANT_ID, '11988887777');

    expect(contact.id).toBe('c1');
    expect(contact.state).toBe('Conversando');
    expect(contactRepo.save).toHaveBeenCalledWith(existing);
    expect(auditService.recordAll).toHaveBeenCalledWith([expect.objectContaining({ eventName: 'ContatoInteragiu' })], 'system');
  });

  it('reconhece um Contact já além de Conversando sem mudar estado nem gerar evento (interagir idempotente)', async () => {
    const existing = Contact.reconstitute({
      id: 'c1',
      tenantId: TENANT_ID,
      phoneNumber: PhoneNumber.normalize('11988887777'),
      name: 'Marcos',
      state: 'Identificado',
    });
    const { useCase, contactRepo, auditService } = makeDeps({ existingContact: existing });

    const contact = await useCase.execute(TENANT_ID, '11988887777');

    expect(contact.state).toBe('Identificado');
    expect(contactRepo.save).toHaveBeenCalledWith(existing);
    expect(auditService.recordAll).toHaveBeenCalledWith([], 'system');
  });

  it('propaga erro de telefone inválido sem tocar o repositório', async () => {
    const { useCase, contactRepo } = makeDeps({ existingContact: null });

    await expect(useCase.execute(TENANT_ID, '123')).rejects.toThrow();
    expect(contactRepo.findByTenantAndPhone).not.toHaveBeenCalled();
    expect(contactRepo.save).not.toHaveBeenCalled();
  });
});
