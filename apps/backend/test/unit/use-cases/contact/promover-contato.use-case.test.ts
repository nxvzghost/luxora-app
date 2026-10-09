import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { PossibleDuplicatePatientError, PromoverContatoUseCase } from '@use-cases/contact/promover-contato.use-case';
import { Contact } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { Patient } from '@domain/patient/patient.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function identifiedContact(overrides: Partial<{ state: 'Conversando' | 'Identificado' | 'Vinculado' | 'Promovido'; phoneNumber: PhoneNumber | null }> = {}) {
  return Contact.reconstitute({
    id: 'c1',
    tenantId: TENANT_ID,
    phoneNumber: overrides.phoneNumber === undefined ? PhoneNumber.normalize('11988887777') : overrides.phoneNumber,
    name: 'Maria da Silva',
    state: overrides.state ?? 'Identificado',
  });
}

function makeDeps(opts: { contact?: Contact | null; sameNumber?: unknown[]; sameName?: unknown[] }) {
  const contact = opts.contact === undefined ? identifiedContact() : opts.contact;
  const contactRepo = {
    findByTenantAndPhone: vi.fn(),
    findById: vi.fn().mockResolvedValue(contact),
    save: vi.fn().mockResolvedValue(undefined),
    saveAssociation: vi.fn().mockResolvedValue(undefined),
    findAssociationsByContactId: vi.fn(),
  };
  const cadastrarPaciente = {
    execute: vi.fn().mockImplementation(async (input: { name: string; phone: string }) =>
      Patient.reconstitute({ id: 'p1', tenantId: TENANT_ID, name: input.name, phone: input.phone, state: 'Cadastrado' }),
    ),
  };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };

  const patientRepo = {
    findAllByPhone: vi.fn().mockResolvedValue(opts.sameNumber ?? []),
    findAllByName: vi.fn().mockResolvedValue(opts.sameName ?? []),
  };

  const useCase = new PromoverContatoUseCase(contactRepo as never, cadastrarPaciente as never, auditService as never, patientRepo as never);
  return { useCase, contactRepo, cadastrarPaciente, auditService, contact, patientRepo };
}

describe('PromoverContatoUseCase — ADR-0055 (AD-018), Fase 6', () => {
  it('cadastra o Patient via CadastrarPacienteUseCase e promove o Contact', async () => {
    const { useCase, contactRepo, cadastrarPaciente, auditService, contact } = makeDeps({});

    const result = await useCase.execute({ contactId: 'c1', patientName: 'Maria da Silva' });

    expect(cadastrarPaciente.execute).toHaveBeenCalledWith({ name: 'Maria da Silva', phone: '+5511988887777' });
    expect(result.patient.id).toBe('p1');
    expect(result.contact.state).toBe('Promovido');
    expect(result.association.patientId).toBe('p1');
    expect(contactRepo.save).toHaveBeenCalledWith(contact);
    expect(contactRepo.saveAssociation).toHaveBeenCalledWith(result.association);
    expect(auditService.recordAll).toHaveBeenCalledWith(expect.any(Array), 'ai_agent');
  });

  it('lança NotFoundException quando o Contact não existe', async () => {
    const { useCase, cadastrarPaciente } = makeDeps({ contact: null });
    await expect(useCase.execute({ contactId: 'inexistente', patientName: 'X' })).rejects.toThrow(NotFoundException);
    expect(cadastrarPaciente.execute).not.toHaveBeenCalled();
  });

  it('lança ConflictException quando o Contact não tem telefone (anonimizado)', async () => {
    const anonimizado = identifiedContact({ phoneNumber: null });
    const { useCase, cadastrarPaciente } = makeDeps({ contact: anonimizado });
    await expect(useCase.execute({ contactId: 'c1', patientName: 'X' })).rejects.toThrow(ConflictException);
    expect(cadastrarPaciente.execute).not.toHaveBeenCalled();
  });

  it.each(['Conversando', 'Vinculado', 'Promovido'] as const)(
    'Contact em "%s" é recusado ANTES de qualquer cadastro — nunca fica um paciente gravado sem contato',
    async (state) => {
      const { useCase, contactRepo, cadastrarPaciente } = makeDeps({ contact: identifiedContact({ state }) });

      await expect(useCase.execute({ contactId: 'c1', patientName: 'Maria da Silva' })).rejects.toThrow(ConflictException);
      expect(cadastrarPaciente.execute).not.toHaveBeenCalled();
      expect(contactRepo.save).not.toHaveBeenCalled();
      expect(contactRepo.saveAssociation).not.toHaveBeenCalled();
    },
  );
});

describe('PromoverContatoUseCase — nunca abre cadastro duplicado (ADR-0063, AD-037)', () => {
  it('o número já consta no cadastro de um paciente: recusa sem cadastrar (D5b)', async () => {
    const { useCase, cadastrarPaciente, contactRepo, patientRepo } = makeDeps({ sameNumber: [{ id: 'p-existente' }] });

    await expect(useCase.execute({ contactId: 'c1', patientName: 'Maria da Silva' })).rejects.toThrow(ConflictException);

    expect(patientRepo.findAllByPhone).toHaveBeenCalledWith('+5511988887777');
    expect(cadastrarPaciente.execute).not.toHaveBeenCalled();
    expect(contactRepo.save).not.toHaveBeenCalled();
  });

  it('já existe paciente com o mesmo nome: PossibleDuplicatePatientError, sem cadastrar', async () => {
    const { useCase, cadastrarPaciente, contactRepo, patientRepo } = makeDeps({ sameName: [{ id: 'p-homonimo' }] });

    await expect(useCase.execute({ contactId: 'c1', patientName: 'Maria da Silva' })).rejects.toThrow(PossibleDuplicatePatientError);

    expect(patientRepo.findAllByName).toHaveBeenCalledWith('Maria da Silva');
    expect(cadastrarPaciente.execute).not.toHaveBeenCalled();
    expect(contactRepo.save).not.toHaveBeenCalled();
    expect(contactRepo.saveAssociation).not.toHaveBeenCalled();
  });

  it('a mensagem do erro de duplicidade não traz o nome nem o id de ninguém', () => {
    const message = new PossibleDuplicatePatientError().message;
    expect(message).not.toMatch(/Maria|p-homonimo/);
  });
});
