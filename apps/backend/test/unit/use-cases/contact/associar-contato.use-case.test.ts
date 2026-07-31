import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AssociarContatoUseCase } from '@use-cases/contact/associar-contato.use-case';
import { Contact, ContactPatientAssociation, ContactNotQualifiedError, DuplicateContactPatientAssociationError } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function vinculadoContact(state: 'Identificado' | 'Vinculado' | 'Promovido' = 'Vinculado') {
  return Contact.reconstitute({
    id: 'c1',
    tenantId: TENANT_ID,
    phoneNumber: PhoneNumber.normalize('11988887777'),
    name: 'Ana',
    state,
  });
}

function makeDeps(opts: { contact?: Contact | null; associations?: ContactPatientAssociation[] }) {
  const contact = opts.contact === undefined ? vinculadoContact() : opts.contact;
  const contactRepo = {
    findByTenantAndPhone: vi.fn(),
    findById: vi.fn().mockResolvedValue(contact),
    save: vi.fn(),
    saveAssociation: vi.fn().mockResolvedValue(undefined),
    findAssociationsByContactId: vi.fn().mockResolvedValue(opts.associations ?? []),
  };
  const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };

  const useCase = new AssociarContatoUseCase(contactRepo as never, auditService as never);
  return { useCase, contactRepo, auditService, contact };
}

describe('AssociarContatoUseCase — ADR-0055 (AD-018), Fase 6', () => {
  it('associa o Contact (já Vinculado) a um segundo Patient, papel padrão responsavel_por', async () => {
    const existing = [ContactPatientAssociation.create({ id: 'a1', tenantId: TENANT_ID, contactId: 'c1', patientId: 'p1', role: 'proprio_paciente' })];
    const { useCase, contactRepo, auditService } = makeDeps({ associations: existing });

    const result = await useCase.execute({ contactId: 'c1', patientId: 'p2' });

    expect(result.association.patientId).toBe('p2');
    expect(result.association.role).toBe('responsavel_por');
    expect(contactRepo.saveAssociation).toHaveBeenCalledWith(result.association);
    expect(auditService.recordAll).toHaveBeenCalledWith(expect.any(Array), 'ai_agent');
  });

  it('aceita role explícito', async () => {
    const { useCase } = makeDeps({ associations: [] });
    const result = await useCase.execute({ contactId: 'c1', patientId: 'p2', role: 'proprio_paciente' });
    expect(result.association.role).toBe('proprio_paciente');
  });

  it('lança NotFoundException quando o Contact não existe', async () => {
    const { useCase, contactRepo } = makeDeps({ contact: null });
    await expect(useCase.execute({ contactId: 'inexistente', patientId: 'p1' })).rejects.toThrow(NotFoundException);
    expect(contactRepo.saveAssociation).not.toHaveBeenCalled();
  });

  it('propaga ContactNotQualifiedError quando o Contact ainda não tem nenhuma associação (deveria ter sido PROMOVER)', async () => {
    const identificado = vinculadoContact('Identificado');
    const { useCase, contactRepo } = makeDeps({ contact: identificado, associations: [] });

    await expect(useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow(ContactNotQualifiedError);
    expect(contactRepo.saveAssociation).not.toHaveBeenCalled();
  });

  it('idempotência: propaga DuplicateContactPatientAssociationError ao tentar associar o mesmo Patient duas vezes, nunca duplica linha', async () => {
    const existing = [ContactPatientAssociation.create({ id: 'a1', tenantId: TENANT_ID, contactId: 'c1', patientId: 'p1', role: 'proprio_paciente' })];
    const { useCase, contactRepo } = makeDeps({ associations: existing });

    await expect(useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow(DuplicateContactPatientAssociationError);
    expect(contactRepo.saveAssociation).not.toHaveBeenCalled();
  });
});
