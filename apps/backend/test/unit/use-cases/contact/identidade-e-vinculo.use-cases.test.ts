import { describe, it, expect, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Contact, ContactPatientAssociation, ContactState } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { isFullName, normalizePersonName } from '@domain/contact/person-name';
import { Patient } from '@domain/patient/patient.entity';
import { TenantContext } from '@shared/tenant-context';
import { ResolverIdentidadeDoContatoUseCase } from '@use-cases/contact/resolver-identidade-do-contato.use-case';
import { IdentificarContatoUseCase } from '@use-cases/contact/identificar-contato.use-case';
import { VincularContatoAPacienteUseCase } from '@use-cases/contact/vincular-contato-a-paciente.use-case';
import { ListarContatosPendentesUseCase } from '@use-cases/contact/listar-contatos-pendentes.use-case';
import { SolicitarAtendimentoHumanoUseCase } from '@use-cases/contact/solicitar-atendimento-humano.use-case';

/**
 * ADR-0063 (AD-037 e AD-038) — os casos de uso novos de identidade: a regra
 * única de reconhecimento, a guarda do nome, a aprovação do vínculo pela
 * clínica, a lista de pendentes e o aviso à equipe.
 */
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PHONE = '+5511988887777';

function contactIn(state: ContactState, name: string | null = null, id = 'c1') {
  return Contact.reconstitute({ id, tenantId: TENANT_ID, phoneNumber: PhoneNumber.fromE164(PHONE), name, state });
}

function patient(id: string, name = 'Ana Prado') {
  return Patient.reconstitute({ id, tenantId: TENANT_ID, name, phone: PHONE, state: 'Cadastrado' });
}

/** Unidade de trabalho de mentira: roda o trabalho na hora e deixa ver se foi usada. */
function fakeUnitOfWork() {
  return { run: vi.fn(async (work: () => Promise<unknown>) => work()) };
}

function association(patientId: string) {
  return ContactPatientAssociation.create({ id: `a-${patientId}`, tenantId: TENANT_ID, contactId: 'c1', patientId, role: 'proprio_paciente' });
}

describe('nome completo (person-name)', () => {
  it.each(['Maria da Silva', 'João Souza', "Ana D'Ávila", 'Luís Sá'])('"%s" é nome completo', (name) => {
    expect(isFullName(name)).toBe(true);
  });

  it.each(['Maria', 'M Silva', 'Maria 2', '', '   ', 'Maria S.'])('"%s" não é nome completo', (name) => {
    expect(isFullName(name)).toBe(false);
  });

  it('a comparação ignora acento, caixa e espaços a mais', () => {
    expect(normalizePersonName('  JOÃO   da Silva ')).toBe(normalizePersonName('joao da silva'));
    expect(normalizePersonName('Mariana Silva')).not.toBe(normalizePersonName('Maria Silva'));
  });
});

describe('ResolverIdentidadeDoContatoUseCase', () => {
  function makeUseCase(opts: { registered?: Patient[]; associations?: ContactPatientAssociation[] }) {
    const contactRepo = { findAssociationsByContactId: vi.fn().mockResolvedValue(opts.associations ?? []) };
    const patientRepo = { findAllByPhone: vi.fn().mockResolvedValue(opts.registered ?? []) };
    return { useCase: new ResolverIdentidadeDoContatoUseCase(contactRepo as never, patientRepo as never), contactRepo, patientRepo };
  }

  it('nenhum paciente com o número: desconhecido', async () => {
    const { useCase } = makeUseCase({});
    expect(await useCase.execute(contactIn('Conversando'))).toEqual({ status: 'unknown' });
  });

  it('exatamente um paciente com o número: reconhecido', async () => {
    const { useCase, patientRepo } = makeUseCase({ registered: [patient('p1')] });

    expect(await useCase.execute(contactIn('Conversando'))).toEqual({ status: 'recognized', patientId: 'p1' });
    expect(patientRepo.findAllByPhone).toHaveBeenCalledWith(PHONE);
  });

  it('dois pacientes com o número: ambíguo — nenhum id de candidato sai, nem o do mais antigo', async () => {
    const { useCase } = makeUseCase({ registered: [patient('p-mais-antigo'), patient('p-mais-novo')] });

    const identity = await useCase.execute(contactIn('Conversando'));

    expect(identity).toEqual({ status: 'ambiguous' });
    expect(JSON.stringify(identity)).not.toMatch(/p-mais/);
  });

  it('vínculo aprovado pela clínica (Contact Vinculado): reconhece o paciente vinculado', async () => {
    const { useCase } = makeUseCase({ associations: [association('p-vinculado')] });
    expect(await useCase.execute(contactIn('Vinculado'))).toEqual({ status: 'recognized', patientId: 'p-vinculado' });
  });

  it('vínculo aprovado para um paciente E o número no cadastro de outro: ambíguo', async () => {
    const { useCase } = makeUseCase({ registered: [patient('p-do-cadastro')], associations: [association('p-vinculado')] });
    expect(await useCase.execute(contactIn('Vinculado'))).toEqual({ status: 'ambiguous' });
  });

  it('o mesmo paciente pelos dois caminhos conta uma vez só', async () => {
    const { useCase } = makeUseCase({ registered: [patient('p1')], associations: [association('p1')] });
    expect(await useCase.execute(contactIn('Vinculado'))).toEqual({ status: 'recognized', patientId: 'p1' });
  });

  it.each(['Novo', 'Conversando', 'Identificado', 'Promovido'] as const)(
    'associação de um Contact em "%s" não identifica ninguém — só o vínculo aprovado e o cadastro',
    async (state) => {
      const { useCase, contactRepo } = makeUseCase({ associations: [association('p-fantasma')] });

      expect(await useCase.execute(contactIn(state))).toEqual({ status: 'unknown' });
      expect(contactRepo.findAssociationsByContactId).not.toHaveBeenCalled();
    },
  );

  it('Contact sem telefone (anonimizado): desconhecido, sem consultar nada', async () => {
    const { useCase, patientRepo } = makeUseCase({ registered: [patient('p1')] });
    const anonymized = Contact.reconstitute({ id: 'c1', tenantId: TENANT_ID, phoneNumber: null, state: 'Descartado' });

    expect(await useCase.execute(anonymized)).toEqual({ status: 'unknown' });
    expect(patientRepo.findAllByPhone).not.toHaveBeenCalled();
  });
});

describe('IdentificarContatoUseCase', () => {
  function makeUseCase(contact: Contact | null) {
    const contactRepo = {
      findById: vi.fn(),
      findByIdForUpdate: vi.fn().mockResolvedValue(contact),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
    const unitOfWork = fakeUnitOfWork();
    const useCase = new IdentificarContatoUseCase(contactRepo as never, auditService as never, unitOfWork as never);
    return { useCase, contactRepo, auditService, unitOfWork };
  }

  it('guarda o nome, leva o Contact a Identificado e audita como ação do agente — sem cadastrar ninguém', async () => {
    const contact = contactIn('Conversando');
    const { useCase, contactRepo, auditService } = makeUseCase(contact);

    const result = await useCase.execute({ contactId: 'c1', name: 'Maria da Silva' });

    expect(result.state).toBe('Identificado');
    expect(result.name).toBe('Maria da Silva');
    expect(contactRepo.save).toHaveBeenCalledWith(contact);
    expect(auditService.recordAll).toHaveBeenCalledWith(expect.any(Array), 'ai_agent');
  });

  it('Contact inexistente: NotFoundException, nada gravado', async () => {
    const { useCase, contactRepo } = makeUseCase(null);

    await expect(useCase.execute({ contactId: 'x', name: 'Maria da Silva' })).rejects.toThrow(NotFoundException);
    expect(contactRepo.save).not.toHaveBeenCalled();
  });

  it('lê o contato com a linha travada, dentro de uma unidade de trabalho — nunca por uma leitura solta', async () => {
    const { useCase, contactRepo, unitOfWork } = makeUseCase(contactIn('Conversando'));

    await useCase.execute({ contactId: 'c1', name: 'Maria da Silva' });

    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
    expect(contactRepo.findByIdForUpdate).toHaveBeenCalledWith('c1');
    expect(contactRepo.findById).not.toHaveBeenCalled();
  });

  it.each(['Vinculado', 'Promovido'] as const)(
    'contato que virou "%s" enquanto a trava era esperada (a clínica aprovou, ou o cadastro foi concluído): recusado, nada regravado',
    async (state) => {
      const { useCase, contactRepo, auditService } = makeUseCase(contactIn(state, 'Carla Nunes'));

      await expect(useCase.execute({ contactId: 'c1', name: 'Outro Nome Qualquer' })).rejects.toThrow(/Transição inválida/);
      expect(contactRepo.save).not.toHaveBeenCalled();
      expect(auditService.recordAll).not.toHaveBeenCalled();
    },
  );
});

describe('VincularContatoAPacienteUseCase — aprovação do vínculo pela clínica', () => {
  function makeUseCase(opts: {
    contact?: Contact | null;
    patient?: Patient | null;
    associations?: ContactPatientAssociation[];
    registered?: Patient[];
    userId?: string | null;
  }) {
    const contact = opts.contact === undefined ? contactIn('Identificado', 'Carla Nunes') : opts.contact;
    const contactRepo = {
      findById: vi.fn(),
      findByIdForUpdate: vi.fn().mockResolvedValue(contact),
      findAssociationsByContactId: vi.fn().mockResolvedValue(opts.associations ?? []),
      save: vi.fn().mockResolvedValue(undefined),
      saveAssociation: vi.fn().mockResolvedValue(undefined),
    };
    const patientRepo = {
      findById: vi.fn().mockResolvedValue(opts.patient === undefined ? patient('p1', 'Carla Nunes') : opts.patient),
      findAllByPhone: vi.fn().mockResolvedValue(opts.registered ?? []),
    };
    const auditService = { recordAll: vi.fn().mockResolvedValue(undefined) };
    const tenantContext = new TenantContext();
    tenantContext.set(TENANT_ID, opts.userId === undefined ? 'admin-1' : opts.userId);
    const unitOfWork = fakeUnitOfWork();
    const useCase = new VincularContatoAPacienteUseCase(
      contactRepo as never,
      patientRepo as never,
      auditService as never,
      tenantContext,
      unitOfWork as never,
    );
    return { useCase, contactRepo, patientRepo, auditService, contact, unitOfWork };
  }

  function expectNothingSaved(deps: ReturnType<typeof makeUseCase>) {
    expect(deps.contactRepo.save).not.toHaveBeenCalled();
    expect(deps.contactRepo.saveAssociation).not.toHaveBeenCalled();
    expect(deps.auditService.recordAll).not.toHaveBeenCalled();
  }

  it('vincula, registra quem aprovou e quando, e audita como ação do usuário', async () => {
    const deps = makeUseCase({});
    const before = Date.now();

    const result = await deps.useCase.execute({ contactId: 'c1', patientId: 'p1' });

    expect(result.contact.state).toBe('Vinculado');
    expect(result.association).toMatchObject({ contactId: 'c1', patientId: 'p1', role: 'proprio_paciente' });
    expect(result.approvedByUserId).toBe('admin-1');
    expect(result.approvedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.approvedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(deps.contactRepo.saveAssociation).toHaveBeenCalledWith(result.association);

    // Sem ator explícito: o AuditService grava o usuário da requisição.
    expect(deps.auditService.recordAll).toHaveBeenCalledTimes(1);
    expect(deps.auditService.recordAll.mock.calls[0]).toHaveLength(1);
    const events = deps.auditService.recordAll.mock.calls[0][0] as Array<{ eventName: string; approvedByUserId?: string; approvedAt?: string }>;
    const linked = events.find((event) => event.eventName === 'ContatoVinculadoAPacienteExistente');
    expect(linked?.approvedByUserId).toBe('admin-1');
    expect(linked?.approvedAt).toBe(result.approvedAt.toISOString());
  });

  it('tudo em uma única unidade de trabalho, com o contato travado ANTES de qualquer conferência', async () => {
    const deps = makeUseCase({});

    await deps.useCase.execute({ contactId: 'c1', patientId: 'p1' });

    expect(deps.unitOfWork.run).toHaveBeenCalledTimes(1);
    expect(deps.contactRepo.findByIdForUpdate).toHaveBeenCalledWith('c1');
    expect(deps.contactRepo.findById).not.toHaveBeenCalled();
    const locked = deps.contactRepo.findByIdForUpdate.mock.invocationCallOrder[0];
    expect(locked).toBeLessThan(deps.contactRepo.findAssociationsByContactId.mock.invocationCallOrder[0]);
    expect(locked).toBeLessThan(deps.patientRepo.findAllByPhone.mock.invocationCallOrder[0]);
    // A auditoria é gravada depois do vínculo e ainda dentro da unidade de trabalho.
    expect(deps.contactRepo.saveAssociation.mock.invocationCallOrder[0]).toBeLessThan(deps.auditService.recordAll.mock.invocationCallOrder[0]);
  });

  it('falha ao gravar a auditoria: o erro sai de DENTRO da unidade de trabalho — é ela que desfaz o vínculo', async () => {
    const deps = makeUseCase({});
    deps.auditService.recordAll.mockRejectedValue(new Error('falha simulada na auditoria'));

    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow('falha simulada na auditoria');
    await expect(deps.unitOfWork.run.mock.results[0].value).rejects.toThrow('falha simulada na auditoria');
  });

  it('falha ao gravar o vínculo: o erro sai de dentro da unidade de trabalho e a auditoria nem é tentada', async () => {
    const deps = makeUseCase({});
    deps.contactRepo.saveAssociation.mockRejectedValue(new Error('falha simulada no vínculo'));

    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow('falha simulada no vínculo');
    await expect(deps.unitOfWork.run.mock.results[0].value).rejects.toThrow('falha simulada no vínculo');
    expect(deps.auditService.recordAll).not.toHaveBeenCalled();
  });

  it('contato que ainda não informou nome: a aprovação da clínica é o que o identifica', async () => {
    const deps = makeUseCase({ contact: contactIn('Conversando') });

    const result = await deps.useCase.execute({ contactId: 'c1', patientId: 'p1' });

    expect(result.contact.state).toBe('Vinculado');
    expect(result.contact.name).toBe('Carla Nunes');
  });

  it('sem usuário na requisição (o pipeline do WhatsApp, por exemplo): recusado, nada gravado', async () => {
    const deps = makeUseCase({ userId: null });

    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow(ForbiddenException);
    expectNothingSaved(deps);
    // Recusado antes de abrir transação ou travar qualquer coisa.
    expect(deps.unitOfWork.run).not.toHaveBeenCalled();
    expect(deps.contactRepo.findByIdForUpdate).not.toHaveBeenCalled();
  });

  it('contato inexistente ou de outra clínica: 404, nada gravado', async () => {
    const deps = makeUseCase({ contact: null });

    await expect(deps.useCase.execute({ contactId: 'c-de-outra', patientId: 'p1' })).rejects.toThrow(NotFoundException);
    expectNothingSaved(deps);
  });

  it('paciente inexistente ou de outra clínica: 404, nada gravado', async () => {
    const deps = makeUseCase({ patient: null });

    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p-de-outra' })).rejects.toThrow(NotFoundException);
    expectNothingSaved(deps);
  });

  it('contato que já tem paciente: recusado, nada gravado', async () => {
    const deps = makeUseCase({ associations: [association('p-anterior')] });

    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow(ConflictException);
    expectNothingSaved(deps);
  });

  it.each(['Vinculado', 'Promovido', 'Arquivado', 'Descartado'] as const)('contato em "%s": recusado, nada gravado', async (state) => {
    const deps = makeUseCase({ contact: contactIn(state, 'Carla Nunes') });

    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow(ConflictException);
    expectNothingSaved(deps);
  });

  it('o número já consta no cadastro de um paciente: não há vínculo a aprovar', async () => {
    const deps = makeUseCase({ registered: [patient('p-do-cadastro')] });

    await expect(deps.useCase.execute({ contactId: 'c1', patientId: 'p1' })).rejects.toThrow(ConflictException);
    expectNothingSaved(deps);
  });
});

describe('ListarContatosPendentesUseCase', () => {
  it('lista os contatos sem paciente e deixa de fora o número que já consta no cadastro de alguém', async () => {
    const waiting = contactIn('Identificado', 'Carla Nunes', 'c-pendente');
    const alreadyRegistered = Contact.reconstitute({ id: 'c-do-cadastro', tenantId: TENANT_ID, phoneNumber: PhoneNumber.fromE164('+5511977776666'), state: 'Conversando' });
    const contactRepo = { findUnlinked: vi.fn().mockResolvedValue([waiting, alreadyRegistered]) };
    const patientRepo = {
      findAllByPhone: vi.fn().mockImplementation(async (phone: string) => (phone === '+5511977776666' ? [patient('p1')] : [])),
    };

    const pending = await new ListarContatosPendentesUseCase(contactRepo as never, patientRepo as never).execute();

    expect(contactRepo.findUnlinked).toHaveBeenCalledWith(100);
    expect(pending).toEqual([{ id: 'c-pendente', phoneNumber: PHONE, name: 'Carla Nunes', state: 'Identificado', createdAt: waiting.createdAt }]);
  });
});

describe('SolicitarAtendimentoHumanoUseCase — aviso à clínica', () => {
  function makeUseCase(opts: { alreadyWaiting?: boolean } = {}) {
    const contactRepo = { findById: vi.fn().mockResolvedValue(contactIn('Identificado', 'Carla Nunes')) };
    const notificationRepo = { hasUnread: vi.fn().mockResolvedValue(opts.alreadyWaiting ?? false), create: vi.fn().mockResolvedValue(undefined) };
    return { useCase: new SolicitarAtendimentoHumanoUseCase(contactRepo as never, notificationRepo as never), contactRepo, notificationRepo };
  }

  it.each([
    ['shared_number', 'whatsapp_shared_number'],
    ['link_request', 'whatsapp_link_request'],
    ['possible_duplicate', 'whatsapp_possible_duplicate'],
    ['human_review', 'whatsapp_human_review'],
  ] as const)('motivo %s cria uma notificação %s ligada ao contato', async (reason, type) => {
    const { useCase, notificationRepo } = makeUseCase();

    await useCase.execute({ tenantId: TENANT_ID, contactId: 'c1', reason });

    const notification = notificationRepo.create.mock.calls[0][0];
    expect(notification).toMatchObject({ tenantId: TENANT_ID, type, entityType: 'Contact', entityId: 'c1' });
    expect(notification.isRead).toBe(false);
  });

  it('o aviso traz só o final do número — nem o número inteiro, nem o nome informado, nem dado de paciente', async () => {
    const { useCase, notificationRepo } = makeUseCase();

    await useCase.execute({ tenantId: TENANT_ID, contactId: 'c1', reason: 'link_request' });

    const { title, message } = notificationRepo.create.mock.calls[0][0];
    expect(message).toContain('7777');
    expect(`${title} ${message}`).not.toContain(PHONE);
    expect(`${title} ${message}`).not.toContain('98888');
    expect(`${title} ${message}`).not.toContain('Carla');
  });

  it('já existe um aviso igual, ainda não lido, para o mesmo contato: não repete', async () => {
    const { useCase, notificationRepo, contactRepo } = makeUseCase({ alreadyWaiting: true });

    await useCase.execute({ tenantId: TENANT_ID, contactId: 'c1', reason: 'shared_number' });

    expect(notificationRepo.hasUnread).toHaveBeenCalledWith('whatsapp_shared_number', 'c1');
    expect(notificationRepo.create).not.toHaveBeenCalled();
    expect(contactRepo.findById).not.toHaveBeenCalled();
  });
});
