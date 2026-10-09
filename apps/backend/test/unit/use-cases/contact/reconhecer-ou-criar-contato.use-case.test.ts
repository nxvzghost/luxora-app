import { describe, it, expect, vi } from 'vitest';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { Contact } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function makeDeps(opts: { existingContact?: Contact | null; lockedContact?: Contact | null } = {}) {
  const contactRepo = {
    findByTenantAndPhone: vi.fn().mockResolvedValue(opts.existingContact ?? null),
    findById: vi.fn(),
    // Por padrão a leitura travada devolve o mesmo contato; cada teste troca quando precisa.
    findByIdForUpdate: vi.fn().mockResolvedValue(opts.lockedContact === undefined ? (opts.existingContact ?? null) : opts.lockedContact),
    save: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
    saveAssociation: vi.fn(),
    findAssociationsByContactId: vi.fn(),
  };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
  // Unidade de trabalho de mentira: roda o trabalho na hora e deixa ver se foi usada.
  const unitOfWork = { run: vi.fn(async (work: () => Promise<unknown>) => work()) };

  const useCase = new ReconhecerOuCriarContatoUseCase(contactRepo as never, auditService as never, unitOfWork as never);

  return { useCase, contactRepo, auditService, unitOfWork };
}

describe('ReconhecerOuCriarContatoUseCase — ADR-0055 (AD-018), Fase 4', () => {
  it('cria um Contact novo quando nenhum existe para o telefone, já em Conversando (interagir aplicado)', async () => {
    const { useCase, contactRepo, auditService } = makeDeps({ existingContact: null });

    const contact = await useCase.execute(TENANT_ID, '11988887777');

    expect(contact.state).toBe('Conversando');
    expect(contact.tenantId).toBe(TENANT_ID);
    expect(contact.phoneNumber?.toE164()).toBe('+5511988887777');
    expect(contactRepo.save).toHaveBeenCalledWith(contact);
    expect(contactRepo.touch).not.toHaveBeenCalled();
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
    const { useCase, contactRepo, auditService, unitOfWork } = makeDeps({ existingContact: existing });

    const contact = await useCase.execute(TENANT_ID, '11988887777');

    expect(contact.id).toBe('c1');
    expect(contact.state).toBe('Conversando');
    expect(contactRepo.save).toHaveBeenCalledWith(existing);
    expect(auditService.recordAll).toHaveBeenCalledWith([expect.objectContaining({ eventName: 'ContatoInteragiu' })], 'system');
    // ADR-0063 (AD-038): a mudança de estado de um contato que já existe
    // acontece com a linha travada, dentro de uma unidade de trabalho.
    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
    expect(contactRepo.findByIdForUpdate).toHaveBeenCalledWith('c1');
  });

  it('contato lido em Novo que deixou de estar em Novo enquanto a trava era esperada: nada é regravado (ADR-0063, AD-038)', async () => {
    const stale = Contact.reconstitute({ id: 'c1', tenantId: TENANT_ID, phoneNumber: PhoneNumber.normalize('11988887777'), state: 'Novo' });
    const fresh = Contact.reconstitute({
      id: 'c1',
      tenantId: TENANT_ID,
      phoneNumber: PhoneNumber.normalize('11988887777'),
      name: 'Carla Nunes',
      state: 'Vinculado',
    });
    const { useCase, contactRepo, auditService } = makeDeps({ existingContact: stale, lockedContact: fresh });

    const contact = await useCase.execute(TENANT_ID, '11988887777');

    expect(contact.state).toBe('Vinculado');
    expect(contactRepo.save).not.toHaveBeenCalled();
    expect(auditService.recordAll).not.toHaveBeenCalled();
  });

  it('reconhece um Contact já além de Conversando sem mudar estado nem gerar evento (interagir idempotente)', async () => {
    const existing = Contact.reconstitute({
      id: 'c1',
      tenantId: TENANT_ID,
      phoneNumber: PhoneNumber.normalize('11988887777'),
      name: 'Marcos',
      state: 'Identificado',
    });
    const { useCase, contactRepo, auditService, unitOfWork } = makeDeps({ existingContact: existing });

    const contact = await useCase.execute(TENANT_ID, '11988887777');

    expect(contact.state).toBe('Identificado');
    // ADR-0063 (AD-038) — este teste fixava a regravação do contato inteiro a
    // cada mensagem (`save` com o estado lido antes). Era o defeito: uma
    // mensagem que chegasse durante a aprovação de um vínculo regravava o
    // estado antigo e desfazia a aprovação. Agora a mensagem só registra a
    // atividade, sem tocar em estado nem em nome.
    expect(contactRepo.touch).toHaveBeenCalledWith('c1');
    expect(contactRepo.save).not.toHaveBeenCalled();
    expect(auditService.recordAll).not.toHaveBeenCalled();
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it.each(['Conversando', 'Vinculado', 'Promovido'] as const)('contato existente em "%s": a mensagem só registra a atividade', async (state) => {
    const existing = Contact.reconstitute({ id: 'c1', tenantId: TENANT_ID, phoneNumber: PhoneNumber.normalize('11988887777'), name: 'Marcos', state });
    const { useCase, contactRepo } = makeDeps({ existingContact: existing });

    const contact = await useCase.execute(TENANT_ID, '11988887777');

    expect(contact.state).toBe(state);
    expect(contactRepo.touch).toHaveBeenCalledWith('c1');
    expect(contactRepo.save).not.toHaveBeenCalled();
  });

  it('propaga erro de telefone inválido sem tocar o repositório', async () => {
    const { useCase, contactRepo } = makeDeps({ existingContact: null });

    await expect(useCase.execute(TENANT_ID, '123')).rejects.toThrow();
    expect(contactRepo.findByTenantAndPhone).not.toHaveBeenCalled();
    expect(contactRepo.save).not.toHaveBeenCalled();
  });
});
