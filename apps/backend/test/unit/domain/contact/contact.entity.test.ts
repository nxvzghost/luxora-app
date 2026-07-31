import { describe, it, expect } from 'vitest';
import {
  Contact,
  ContactPatientAssociation,
  ContactNotQualifiedError,
  DuplicateContactPatientAssociationError,
  BlankContactNameError,
} from '@domain/contact/contact.entity';
import { InvalidStateTransitionError } from '@domain/shared/state-machine';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PHONE = PhoneNumber.normalize('11988887777');

function newContact() {
  return Contact.create({ id: 'c1', tenantId: TENANT_ID, phoneNumber: PHONE });
}

/** Avança um Contact recém-criado até Identificado — atalho comum a vários testes. */
function identifiedContact(name = 'Maria') {
  const contact = newContact();
  contact.interagir();
  contact.identificar(name);
  contact.pullDomainEvents();
  return contact;
}

describe('Contact — Aggregate Root (ADR-0055, Marco 1)', () => {
  describe('create()', () => {
    it('nasce no estado Novo, sem nome, com o telefone informado', () => {
      const contact = newContact();
      expect(contact.state).toBe('Novo');
      expect(contact.name).toBeNull();
      expect(contact.phoneNumber?.equals(PHONE)).toBe(true);
    });

    it('não emite nenhum evento na criação simples', () => {
      const contact = newContact();
      expect(contact.pullDomainEvents()).toHaveLength(0);
    });
  });

  describe('createAlreadyLinked() — Cenário 14 (paciente cadastrado pelo painel)', () => {
    it('nasce já Vinculado, pulando toda a fase de qualificação', () => {
      const { contact, association } = Contact.createAlreadyLinked({
        id: 'c1',
        tenantId: TENANT_ID,
        phoneNumber: PHONE,
        associationId: 'a1',
        patientId: 'p1',
      });

      expect(contact.state).toBe('Vinculado');
      expect(contact.name).toBeNull();
      expect(association.contactId).toBe('c1');
      expect(association.patientId).toBe('p1');
      expect(association.role).toBe('proprio_paciente');
    });

    it('emite ContatoCriado + ContatoAssociadoAPaciente + ContatoReconciliadoComPacienteExistente, nesta ordem', () => {
      const { contact } = Contact.createAlreadyLinked({
        id: 'c1',
        tenantId: TENANT_ID,
        phoneNumber: PHONE,
        associationId: 'a1',
        patientId: 'p1',
      });

      const events = contact.pullDomainEvents();
      expect(events.map((e) => e.eventName)).toEqual([
        'ContatoCriado',
        'ContatoAssociadoAPaciente',
        'ContatoReconciliadoComPacienteExistente',
      ]);
    });
  });

  describe('interagir() — Cenário 1/2', () => {
    it('avança de Novo para Conversando e emite ContatoInteragiu', () => {
      const contact = newContact();
      contact.interagir();

      expect(contact.state).toBe('Conversando');
      const events = contact.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('ContatoInteragiu');
    });

    it('é idempotente — chamar de novo já em Conversando não muda estado nem emite evento', () => {
      const contact = newContact();
      contact.interagir();
      contact.pullDomainEvents();

      contact.interagir();

      expect(contact.state).toBe('Conversando');
      expect(contact.pullDomainEvents()).toHaveLength(0);
    });

    it('é idempotente mesmo além de Conversando (ex.: já Identificado)', () => {
      const contact = identifiedContact();
      contact.interagir();

      expect(contact.state).toBe('Identificado');
      expect(contact.pullDomainEvents()).toHaveLength(0);
    });
  });

  describe('identificar() — captura de nome', () => {
    it('avança de Conversando para Identificado e emite ContatoIdentificado com o nome', () => {
      const contact = newContact();
      contact.interagir();
      contact.pullDomainEvents();

      contact.identificar('  Maria da Silva  ');

      expect(contact.state).toBe('Identificado');
      expect(contact.name).toBe('Maria da Silva');
      const events = contact.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('ContatoIdentificado');
      expect((events[0] as unknown as { name: string }).name).toBe('Maria da Silva');
    });

    it('rejeita nome vazio ou só espaços', () => {
      const contact = newContact();
      contact.interagir();
      expect(() => contact.identificar('   ')).toThrow(BlankContactNameError);
    });

    it('nunca pula etapa — identificar() direto de Novo (sem interagir primeiro) lança erro', () => {
      const contact = newContact();
      expect(() => contact.identificar('Maria')).toThrow(InvalidStateTransitionError);
    });
  });

  describe('promoverParaPaciente() — Cenário 3 (evento de negócio "primeira consulta agendada")', () => {
    it('avança de Identificado para Promovido, papel padrão proprio_paciente', () => {
      const contact = identifiedContact();

      const association = contact.promoverParaPaciente('a1', 'p1');

      expect(contact.state).toBe('Promovido');
      expect(association.role).toBe('proprio_paciente');
      expect(association.contactId).toBe('c1');
      expect(association.patientId).toBe('p1');
    });

    it('emite ContatoAssociadoAPaciente + ContatoPromovidoParaPaciente, nesta ordem', () => {
      const contact = identifiedContact();
      contact.promoverParaPaciente('a1', 'p1');

      const events = contact.pullDomainEvents();
      expect(events.map((e) => e.eventName)).toEqual(['ContatoAssociadoAPaciente', 'ContatoPromovidoParaPaciente']);
    });

    it('aceita papel responsavel_por (Cenário 11, primeira associação já é de um dependente)', () => {
      const contact = identifiedContact();
      const association = contact.promoverParaPaciente('a1', 'p1', 'responsavel_por');
      expect(association.role).toBe('responsavel_por');
    });

    it('nunca promove sem passar por Identificado — de Novo lança erro', () => {
      const contact = newContact();
      expect(() => contact.promoverParaPaciente('a1', 'p1')).toThrow(InvalidStateTransitionError);
    });

    it('nunca promove duas vezes — de Promovido lança erro', () => {
      const contact = identifiedContact();
      contact.promoverParaPaciente('a1', 'p1');
      expect(() => contact.promoverParaPaciente('a2', 'p2')).toThrow(InvalidStateTransitionError);
    });
  });

  describe('vincularAPacienteExistente() — Cenário 13 (troca de número, após confirmação)', () => {
    it('avança de Identificado para Vinculado, papel sempre proprio_paciente', () => {
      const contact = identifiedContact();
      const association = contact.vincularAPacienteExistente('a1', 'p1');

      expect(contact.state).toBe('Vinculado');
      expect(association.role).toBe('proprio_paciente');
    });

    it('emite ContatoAssociadoAPaciente + ContatoVinculadoAPacienteExistente', () => {
      const contact = identifiedContact();
      contact.vincularAPacienteExistente('a1', 'p1');

      const events = contact.pullDomainEvents();
      expect(events.map((e) => e.eventName)).toEqual(['ContatoAssociadoAPaciente', 'ContatoVinculadoAPacienteExistente']);
    });
  });

  describe('associarAPaciente() — associação adicional (Cenário 11 tardio / Cenário 12, casal)', () => {
    it('exige Contact já Vinculado ou Promovido — de Identificado lança ContactNotQualifiedError', () => {
      const contact = identifiedContact();
      expect(() => contact.associarAPaciente('a2', 'p2', 'proprio_paciente', [])).toThrow(ContactNotQualifiedError);
    });

    it('adiciona uma segunda associação sem mudar o estado', () => {
      const contact = identifiedContact();
      contact.promoverParaPaciente('a1', 'p1');
      contact.pullDomainEvents();

      const existing = [ContactPatientAssociation.create({ id: 'a1', tenantId: TENANT_ID, contactId: 'c1', patientId: 'p1', role: 'proprio_paciente' })];
      const second = contact.associarAPaciente('a2', 'p2', 'responsavel_por', existing);

      expect(contact.state).toBe('Promovido');
      expect(second.patientId).toBe('p2');
      expect(second.role).toBe('responsavel_por');
    });

    it('emite só ContatoAssociadoAPaciente (nunca um segundo evento de promoção)', () => {
      const contact = identifiedContact();
      contact.promoverParaPaciente('a1', 'p1');
      contact.pullDomainEvents();

      contact.associarAPaciente('a2', 'p2', 'responsavel_por', []);
      const events = contact.pullDomainEvents();
      expect(events.map((e) => e.eventName)).toEqual(['ContatoAssociadoAPaciente']);
    });

    it('nunca duplica associação para o mesmo Patient (invariante de não-duplicidade)', () => {
      const contact = identifiedContact();
      contact.promoverParaPaciente('a1', 'p1');
      contact.pullDomainEvents();

      const existing = [ContactPatientAssociation.create({ id: 'a1', tenantId: TENANT_ID, contactId: 'c1', patientId: 'p1', role: 'proprio_paciente' })];
      expect(() => contact.associarAPaciente('a2', 'p1', 'proprio_paciente', existing)).toThrow(
        DuplicateContactPatientAssociationError,
      );
    });
  });

  describe('arquivar() — Cenário 15 (retenção, ramo paralelo)', () => {
    it('arquiva a partir de Novo', () => {
      const contact = newContact();
      contact.arquivar();
      expect(contact.state).toBe('Arquivado');
      expect(contact.pullDomainEvents()[0].eventName).toBe('ContatoArquivado');
    });

    it('arquiva a partir de Conversando', () => {
      const contact = newContact();
      contact.interagir();
      contact.arquivar();
      expect(contact.state).toBe('Arquivado');
    });

    it('nunca arquiva um Contact já Identificado — fora do que os documentos congelados definem', () => {
      const contact = identifiedContact();
      expect(() => contact.arquivar()).toThrow(InvalidStateTransitionError);
    });
  });

  describe('anonimizar() — expurgo LGPD', () => {
    it('só a partir de Arquivado, limpa telefone e nome, avança para Descartado', () => {
      const contact = newContact();
      contact.arquivar();
      contact.pullDomainEvents();

      contact.anonimizar();

      expect(contact.state).toBe('Descartado');
      expect(contact.phoneNumber).toBeNull();
      expect(contact.name).toBeNull();
      expect(contact.pullDomainEvents()[0].eventName).toBe('ContatoAnonimizado');
    });

    it('nunca anonimiza direto de Novo (sem passar por Arquivado)', () => {
      const contact = newContact();
      expect(() => contact.anonimizar()).toThrow(InvalidStateTransitionError);
    });
  });

  describe('pullDomainEvents()', () => {
    it('esvazia a fila — nunca retorna o mesmo evento duas vezes', () => {
      const contact = newContact();
      contact.interagir();

      expect(contact.pullDomainEvents()).toHaveLength(1);
      expect(contact.pullDomainEvents()).toHaveLength(0);
    });
  });

  describe('reconstitute()', () => {
    it('restaura um Contact com telefone e nome preservados', () => {
      const contact = Contact.reconstitute({
        id: 'c1',
        tenantId: TENANT_ID,
        phoneNumber: PHONE,
        name: 'Maria',
        state: 'Identificado',
        createdAt: new Date('2026-01-01'),
      });

      expect(contact.state).toBe('Identificado');
      expect(contact.name).toBe('Maria');
      expect(contact.phoneNumber?.equals(PHONE)).toBe(true);
    });

    it('restaura um Contact anonimizado, com telefone e nome nulos', () => {
      const contact = Contact.reconstitute({
        id: 'c1',
        tenantId: TENANT_ID,
        phoneNumber: null,
        name: null,
        state: 'Descartado',
      });

      expect(contact.state).toBe('Descartado');
      expect(contact.phoneNumber).toBeNull();
      expect(contact.name).toBeNull();
    });

    it('não emite nenhum evento ao reconstituir — reconstituição nunca é um fato novo', () => {
      const contact = Contact.reconstitute({
        id: 'c1',
        tenantId: TENANT_ID,
        phoneNumber: PHONE,
        state: 'Novo',
      });
      expect(contact.pullDomainEvents()).toHaveLength(0);
    });
  });
});

describe('ContactPatientAssociation — Entity', () => {
  it('create() define createdAt automaticamente', () => {
    const association = ContactPatientAssociation.create({
      id: 'a1',
      tenantId: TENANT_ID,
      contactId: 'c1',
      patientId: 'p1',
      role: 'proprio_paciente',
    });
    expect(association.createdAt).toBeInstanceOf(Date);
    expect(association.role).toBe('proprio_paciente');
  });

  it('reconstitute() preserva todos os campos, incluindo createdAt informado', () => {
    const createdAt = new Date('2026-01-01');
    const association = ContactPatientAssociation.reconstitute({
      id: 'a1',
      tenantId: TENANT_ID,
      contactId: 'c1',
      patientId: 'p1',
      role: 'responsavel_por',
      createdAt,
    });
    expect(association.createdAt).toBe(createdAt);
    expect(association.role).toBe('responsavel_por');
  });
});
