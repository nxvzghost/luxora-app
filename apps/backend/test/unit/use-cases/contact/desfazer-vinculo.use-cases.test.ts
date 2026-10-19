import { describe, it, expect, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  Contact,
  ContactNotLinkedError,
  ContactPatientAssociation,
  ContactState,
  ContactUnlinkWithoutUserError,
} from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { Patient } from '@domain/patient/patient.entity';
import { TenantContext } from '@shared/tenant-context';
import { DesfazerVinculoDoContatoUseCase } from '@use-cases/contact/desfazer-vinculo-do-contato.use-case';
import { ListarVinculosAprovadosUseCase } from '@use-cases/contact/listar-vinculos-aprovados.use-case';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PHONE = '+5511988887777';

function contactIn(state: ContactState, name: string | null = 'Carla Nunes', id = 'c1') {
  return Contact.reconstitute({ id, tenantId: TENANT_ID, phoneNumber: PhoneNumber.fromE164(PHONE), name, state });
}

function patient(id: string, name = 'Carla Nunes', phone = '+5511900000000') {
  return Patient.reconstitute({ id, tenantId: TENANT_ID, name, phone, state: 'Cadastrado' });
}

function association(patientId: string, contactId = 'c1') {
  return ContactPatientAssociation.create({ id: `a-${patientId}`, tenantId: TENANT_ID, contactId, patientId, role: 'proprio_paciente' });
}

describe('Contact.desfazerVinculo — A-10', () => {
  const undo = { undoneByUserId: 'admin-1', undoneAt: new Date('2026-10-19T12:00:00.000Z') };

  it('sem outro vínculo: volta a Identificado, mantém o nome e registra quem desfez e quando', () => {
    const contact = contactIn('Vinculado');
    contact.desfazerVinculo('p1', undo, 0);
    expect(contact.state).toBe('Identificado');
    expect(contact.name).toBe('Carla Nunes');
    const [event] = contact.pullDomainEvents() as Array<{ eventName: string; patientId?: string; undoneByUserId?: string; undoneAt?: string }>;
    expect(event).toMatchObject({ eventName: 'ContatoDesvinculadoDePaciente', patientId: 'p1', undoneByUserId: 'admin-1', undoneAt: '2026-10-19T12:00:00.000Z' });
  });

  it('com outro vínculo ainda de pé: continua Vinculado', () => {
    const contact = contactIn('Vinculado');
    contact.desfazerVinculo('p1', undo, 1);
    expect(contact.state).toBe('Vinculado');
  });

  it.each(['Novo', 'Conversando', 'Identificado', 'Promovido', 'Arquivado', 'Descartado'] as const)('em "%s": recusado', (state) => {
    expect(() => contactIn(state).desfazerVinculo('p1', undo, 0)).toThrow(ContactNotLinkedError);
  });

  it('sem quem desfez: recusado', () => {
    expect(() => contactIn('Vinculado').desfazerVinculo('p1', { undoneByUserId: '', undoneAt: new Date() }, 0)).toThrow(
      ContactUnlinkWithoutUserError,
    );
  });

  it('identificar() continua sem conseguir tirar o contato de Vinculado', () => {
    expect(() => contactIn('Vinculado').identificar('Outro Nome')).toThrow();
  });
});

describe('DesfazerVinculoDoContatoUseCase — A-10', () => {
  function makeUseCase(opts: { contact?: Contact | null; associations?: ContactPatientAssociation[]; registered?: Patient[]; userId?: string | null } = {}) {
    const contact = opts.contact === undefined ? contactIn('Vinculado') : opts.contact;
    const contactRepo = {
      findById: vi.fn(),
      findByIdForUpdate: vi.fn().mockResolvedValue(contact),
      findAssociationsByContactId: vi.fn().mockResolvedValue(opts.associations ?? [association('p1')]),
      deleteAssociation: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const patientRepo = { findAllByPhone: vi.fn().mockResolvedValue(opts.registered ?? []) };
    const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
    const tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, opts.userId === undefined ? 'admin-1' : opts.userId);
    const unitOfWork = { run: vi.fn(async (work: () => Promise<unknown>) => work()) };
    const useCase = new DesfazerVinculoDoContatoUseCase(contactRepo as never, patientRepo as never, auditService as never, tenantContext, unitOfWork as never);
    return { useCase, contactRepo, patientRepo, auditService, unitOfWork, contact };
  }

  function expectNothingWritten(deps: ReturnType<typeof makeUseCase>) {
    expect(deps.contactRepo.deleteAssociation).not.toHaveBeenCalled();
    expect(deps.contactRepo.save).not.toHaveBeenCalled();
    expect(deps.auditService.recordAll).not.toHaveBeenCalled();
  }

  it('desfaz: apaga o vínculo, devolve o contato a Identificado e audita quem desfez — numa unidade de trabalho, com o contato travado antes', async () => {
    const deps = makeUseCase();
    const before = Date.now();

    const result = await deps.useCase.execute({ contactId: 'c1', patientId: 'p1' });

    expect(result.contact.state).toBe('Identificado');
    expect(result.patientId).toBe('p1');
    expect(result.undoneByUserId).toBe('admin-1');
    expect(result.undoneAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(deps.contactRepo.deleteAssociation).toHaveBeenCalledWith('a-p1');
    expect(deps.contactRepo.save).toHaveBeenCalledWith(result.contact);

    expect(deps.unitOfWork.run).toHaveBeenCalledTimes(1);
    const locked = deps.contactRepo.findByIdForUpdate.mock.invocationCallOrder[0];
    expect(locked).toBeLessThan(deps.contactRepo.findAssociationsByContactId.mock.invocationCallOrder[0]);
    expect(locked).toBeLessThan(deps.patientRepo.findAllByPhone.mock.invocationCallOrder[0]);
    expect(deps.contactRepo.findById).not.toHaveBeenCalled();

    const events = deps.auditService.recordAll.mock.calls[0][0] as Array<{ eventName: string; undoneByUserId?: string; undoneAt?: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventName: 'ContatoDesvinculadoDePaciente', undoneByUserId: 'admin-1', undoneAt: result.undoneAt.toISOString() });
  });

  it('sem usuário na requisição: recusado, nada gravado', async () => {
    const deps = makeUseCase({ userId: null });
    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.unitOfWork.run).not.toHaveBeenCalled();
    expectNothingWritten(deps);
  });

  it('contato inexistente ou de outra clínica: 404, nada gravado', async () => {
    const deps = makeUseCase({ contact: null });
    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toBeInstanceOf(NotFoundException);
    expectNothingWritten(deps);
  });

  it('o número não está vinculado a esse paciente: 404, nada gravado', async () => {
    const deps = makeUseCase({ associations: [association('p2')] });
    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toBeInstanceOf(NotFoundException);
    expectNothingWritten(deps);
  });

  it('contato que não está Vinculado (já desfeito, ou cadastrado pelo WhatsApp): 404, nada gravado', async () => {
    const deps = makeUseCase({ contact: contactIn('Promovido') });
    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toBeInstanceOf(NotFoundException);
    expectNothingWritten(deps);
  });

  it('o número consta no cadastro do paciente: 409, que manda alterar o cadastro — nada gravado', async () => {
    const deps = makeUseCase({ registered: [patient('p1', 'Carla Nunes', PHONE)] });
    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toBeInstanceOf(ConflictException);
    expectNothingWritten(deps);
  });

  it('com dois vínculos, desfazer um mantém o contato Vinculado', async () => {
    const deps = makeUseCase({ associations: [association('p1'), association('p2')] });
    const result = await deps.useCase.execute({ contactId: 'c1', patientId: 'p1' });
    expect(result.contact.state).toBe('Vinculado');
    expect(deps.contactRepo.deleteAssociation).toHaveBeenCalledWith('a-p1');
  });

  it('falha ao gravar a auditoria: o erro sai de dentro da unidade de trabalho — é ela que desfaz tudo', async () => {
    const deps = makeUseCase();
    deps.auditService.recordAll.mockRejectedValue(new Error('falha simulada na auditoria'));
    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow('falha simulada na auditoria');
    await expect(deps.unitOfWork.run.mock.results[0].value).rejects.toThrow('falha simulada na auditoria');
  });
});

describe('ListarVinculosAprovadosUseCase — A-10', () => {
  it('lista os vínculos aprovados e deixa de fora o número que está no cadastro do próprio paciente', async () => {
    const approved = contactIn('Vinculado', 'Carla Nunes', 'c1');
    const contactRepo = {
      findLinked: vi.fn().mockResolvedValue([{ contact: approved, associations: [association('p1'), association('p2')] }]),
    };
    const patientRepo = {
      findAllByPhone: vi.fn().mockResolvedValue([patient('p2', 'Bruno Lima', PHONE)]),
      findById: vi.fn(async (id: string) => (id === 'p1' ? patient('p1', 'Carla Nunes') : patient('p2', 'Bruno Lima', PHONE))),
    };
    const useCase = new ListarVinculosAprovadosUseCase(contactRepo as never, patientRepo as never);

    const result = await useCase.execute();

    expect(contactRepo.findLinked).toHaveBeenCalledWith(100);
    expect(result).toEqual([{ contactId: 'c1', phoneNumber: PHONE, patientId: 'p1', patientName: 'Carla Nunes', linkedAt: expect.any(Date) }]);
  });

  it('paciente que não existe mais (ou de outra clínica): fora da lista', async () => {
    const contactRepo = { findLinked: vi.fn().mockResolvedValue([{ contact: contactIn('Vinculado'), associations: [association('p1')] }]) };
    const patientRepo = { findAllByPhone: vi.fn().mockResolvedValue([]), findById: vi.fn().mockResolvedValue(null) };
    expect(await new ListarVinculosAprovadosUseCase(contactRepo as never, patientRepo as never).execute()).toEqual([]);
  });
});
