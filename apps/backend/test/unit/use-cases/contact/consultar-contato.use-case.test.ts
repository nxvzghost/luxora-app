import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultarContatoUseCase } from '@use-cases/contact/consultar-contato.use-case';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function makeDeps(opts: { contact?: Contact | null; associations?: ContactPatientAssociation[] }) {
  const contact =
    opts.contact === undefined
      ? Contact.reconstitute({ id: 'c1', tenantId: TENANT_ID, phoneNumber: PhoneNumber.normalize('11988887777'), state: 'Novo' })
      : opts.contact;

  const contactRepo = {
    findByTenantAndPhone: vi.fn(),
    findById: vi.fn().mockResolvedValue(contact),
    save: vi.fn(),
    saveAssociation: vi.fn(),
    findAssociationsByContactId: vi.fn().mockResolvedValue(opts.associations ?? []),
  };

  const useCase = new ConsultarContatoUseCase(contactRepo as never);
  return { useCase, contactRepo };
}

describe('ConsultarContatoUseCase — ADR-0055 (AD-018), Fase 6', () => {
  it('devolve o Contact e suas associações', async () => {
    const association = ContactPatientAssociation.create({ id: 'a1', tenantId: TENANT_ID, contactId: 'c1', patientId: 'p1', role: 'proprio_paciente' });
    const { useCase, contactRepo } = makeDeps({ associations: [association] });

    const result = await useCase.execute('c1');

    expect(result.contact.id).toBe('c1');
    expect(result.associations).toEqual([association]);
    expect(contactRepo.findAssociationsByContactId).toHaveBeenCalledWith('c1');
  });

  it('lança NotFoundException quando o Contact não existe', async () => {
    const { useCase, contactRepo } = makeDeps({ contact: null });
    await expect(useCase.execute('inexistente')).rejects.toThrow(NotFoundException);
    expect(contactRepo.findAssociationsByContactId).not.toHaveBeenCalled();
  });
});
