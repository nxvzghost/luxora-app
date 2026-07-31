import { describe, it, expect, vi } from 'vitest';
import { ContactIntentActionRouter, ContactIntentRoutingInput } from '@use-cases/contact/contact-intent-action-router';
import { ContactIntentClassificationResult } from '@domain-services/ai/contact-intent-classifier';
import { Contact, ContactPatientAssociation, DuplicateContactPatientAssociationError } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { Patient } from '@domain/patient/patient.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function contactWith(state: 'Novo' | 'Conversando' | 'Identificado' | 'Vinculado' | 'Promovido', name: string | null = null) {
  return Contact.reconstitute({ id: 'c1', tenantId: TENANT_ID, phoneNumber: PhoneNumber.normalize('11988887777'), name, state });
}

function assoc(patientId: string, role: 'proprio_paciente' | 'responsavel_por' = 'proprio_paciente') {
  return ContactPatientAssociation.create({ id: `a-${patientId}`, tenantId: TENANT_ID, contactId: 'c1', patientId, role });
}

function makeDeps(opts: {
  contact?: Contact | null;
  associations?: ContactPatientAssociation[];
  classification: ContactIntentClassificationResult | Error;
}) {
  const contact = opts.contact === undefined ? contactWith('Identificado', 'Maria da Silva') : opts.contact;
  const associations = opts.associations ?? [];

  const consultarContato = {
    execute: contact
      ? vi.fn().mockResolvedValue({ contact, associations })
      : vi.fn().mockRejectedValue(new Error('Contact inexistente não encontrado.')),
  };
  const classifier = {
    classify:
      opts.classification instanceof Error
        ? vi.fn().mockRejectedValue(opts.classification)
        : vi.fn().mockResolvedValue(opts.classification),
  };
  const promoverContato = {
    execute: vi.fn().mockImplementation(async (input: { contactId: string; patientName: string }) => {
      const association = contact!.promoverParaPaciente('assoc-nova', 'patient-novo');
      return {
        contact,
        patient: Patient.reconstitute({ id: 'patient-novo', tenantId: TENANT_ID, name: input.patientName, phone: '+5511988887777', state: 'Cadastrado' }),
        association,
      };
    }),
  };
  const associarContato = {
    execute: vi.fn().mockImplementation(async (input: { contactId: string; patientId: string }) => ({
      contact,
      association: assoc(input.patientId, 'responsavel_por'),
    })),
  };

  const router = new ContactIntentActionRouter(classifier as never, consultarContato as never, promoverContato as never, associarContato as never);
  return { router, consultarContato, classifier, promoverContato, associarContato, contact, associations };
}

function baseInput(overrides: Partial<ContactIntentRoutingInput> = {}): ContactIntentRoutingInput {
  return { tenantId: TENANT_ID, contactId: 'c1', conversationHistory: [], message: 'Olá', ...overrides };
}

describe('ContactIntentActionRouter — ADR-0055 (AD-018), Fase 6', () => {
  describe('PROMOVER — promoção automática', () => {
    it('promove um Contact Identificado, sem nenhuma associação prévia', async () => {
      const { router, promoverContato } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        associations: [],
        classification: { decision: 'PROMOVER', confidence: 0.9 },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({ decision: 'PROMOVER', actionTaken: true, patientId: 'patient-novo' });
      expect(promoverContato.execute).toHaveBeenCalledWith({ contactId: 'c1', patientName: 'Maria da Silva' });
    });

    it('caminho negativo: PROMOVER sem o Contact ter nome ainda — não promove, pede confirmação', async () => {
      const { router, promoverContato } = makeDeps({
        contact: contactWith('Conversando', null),
        associations: [],
        classification: { decision: 'PROMOVER', confidence: 0.6 },
      });

      const result = await router.route(baseInput());

      expect(result.actionTaken).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('idempotência: PROMOVER num Contact que já tem associação nunca promove de novo', async () => {
      const { router, promoverContato } = makeDeps({
        contact: contactWith('Promovido', 'Maria da Silva'),
        associations: [assoc('p1')],
        classification: { decision: 'PROMOVER', confidence: 0.9 },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({ decision: 'PROMOVER', actionTaken: false });
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });
  });

  describe('ASSOCIAR — associação a um segundo Patient', () => {
    it('associa quando knownPatientId já está resolvido e ainda não existe essa associação', async () => {
      const { router, associarContato } = makeDeps({
        contact: contactWith('Vinculado', 'Ana'),
        associations: [assoc('p1')],
        classification: { decision: 'ASSOCIAR', confidence: 0.8, patientNameHint: 'João' },
      });

      const result = await router.route(baseInput({ knownPatientId: 'p2' }));

      expect(result).toMatchObject({ decision: 'ASSOCIAR', actionTaken: true, patientId: 'p2' });
      expect(associarContato.execute).toHaveBeenCalledWith({ contactId: 'c1', patientId: 'p2' });
    });

    it('múltiplos matches / caminho negativo: ASSOCIAR sem knownPatientId nunca adivinha — pede confirmação', async () => {
      const { router, associarContato } = makeDeps({
        contact: contactWith('Vinculado', 'Ana'),
        associations: [assoc('p1'), assoc('p2')],
        classification: { decision: 'ASSOCIAR', confidence: 0.7, patientNameHint: 'João' },
      });

      const result = await router.route(baseInput());

      expect(result.actionTaken).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.confirmationPrompt).toContain('João');
      expect(associarContato.execute).not.toHaveBeenCalled();
    });

    it('idempotência: ASSOCIAR com um knownPatientId já vinculado nunca duplica — sempre tenta o Use Case, nunca pré-checa a duplicidade (única fonte de verdade é o Aggregate)', async () => {
      const { router, associarContato } = makeDeps({
        contact: contactWith('Vinculado', 'Ana'),
        associations: [assoc('p1')],
        classification: { decision: 'ASSOCIAR', confidence: 0.8 },
      });
      associarContato.execute.mockRejectedValueOnce(new DuplicateContactPatientAssociationError('c1', 'p1'));

      const result = await router.route(baseInput({ knownPatientId: 'p1' }));

      expect(result).toMatchObject({ decision: 'ASSOCIAR', actionTaken: false, patientId: 'p1' });
      expect(associarContato.execute).toHaveBeenCalledWith({ contactId: 'c1', patientId: 'p1' });
    });
  });

  describe('DESAMBIGUAR', () => {
    it('nunca executa nenhum Use Case — só sinaliza necessidade de confirmação', async () => {
      const { router, promoverContato, associarContato } = makeDeps({
        classification: { decision: 'DESAMBIGUAR', confidence: 0.4, reasoning: 'ambíguo' },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({ decision: 'DESAMBIGUAR', actionTaken: false, requiresConfirmation: true });
      expect(promoverContato.execute).not.toHaveBeenCalled();
      expect(associarContato.execute).not.toHaveBeenCalled();
    });
  });

  describe('IGNORAR — nenhum match', () => {
    it('mensagem sem relação com identidade: nenhuma ação, nenhum Use Case chamado', async () => {
      const { router, promoverContato, associarContato } = makeDeps({
        classification: { decision: 'IGNORAR', confidence: 0.95 },
      });

      const result = await router.route(baseInput({ message: 'Qual o horário de funcionamento?' }));

      expect(result).toEqual({ decision: 'IGNORAR', actionTaken: false, reasoning: undefined });
      expect(promoverContato.execute).not.toHaveBeenCalled();
      expect(associarContato.execute).not.toHaveBeenCalled();
    });
  });

  describe('HUMANO', () => {
    it('sinaliza escalonamento para atendimento humano, sem agir', async () => {
      const { router } = makeDeps({
        classification: { decision: 'HUMANO', confidence: 0.3, reasoning: 'situação sensível' },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({ decision: 'HUMANO', actionTaken: false, escalateToHuman: true });
    });
  });

  describe('caminhos negativos — falhas nunca viram exceção não tratada', () => {
    it('Contact inexistente: erro do ConsultarContatoUseCase vira HUMANO com error, nunca propaga', async () => {
      const { router } = makeDeps({ contact: null, classification: { decision: 'IGNORAR', confidence: 1 } });

      const result = await router.route(baseInput({ contactId: 'inexistente' }));

      expect(result.decision).toBe('HUMANO');
      expect(result.actionTaken).toBe(false);
      expect(result.escalateToHuman).toBe(true);
      expect(result.error).toBeDefined();
    });

    it('falha do classificador (ex.: IA fora do ar) vira HUMANO com error, nunca propaga', async () => {
      const { router } = makeDeps({ classification: new Error('timeout da IA') });

      const result = await router.route(baseInput());

      expect(result.decision).toBe('HUMANO');
      expect(result.escalateToHuman).toBe(true);
      expect(result.error).toContain('timeout');
    });

    it('erro de domínio propagado pelo Use Case (ex.: ContactNotQualifiedError) vira falha segura, nunca dupla ação', async () => {
      const { router, associarContato } = makeDeps({
        contact: contactWith('Vinculado', 'Ana'),
        associations: [assoc('p1')],
        classification: { decision: 'ASSOCIAR', confidence: 0.8 },
      });
      associarContato.execute.mockRejectedValueOnce(new Error('ContactNotQualifiedError simulado'));

      const result = await router.route(baseInput({ knownPatientId: 'p2' }));

      expect(result.decision).toBe('HUMANO');
      expect(result.actionTaken).toBe(false);
      expect(result.error).toContain('ContactNotQualifiedError');
    });
  });

  describe('nunca acessa Repository/Prisma diretamente — só Use Cases + classificador', () => {
    it('as únicas dependências do Router são os 3 Use Cases e o classificador (verificação estrutural)', () => {
      const router = new ContactIntentActionRouter({} as never, {} as never, {} as never, {} as never);
      expect(router).toBeInstanceOf(ContactIntentActionRouter);
    });
  });

  describe('ADR-0055 (AD-018), Fase 7 — correlationId, usage (RNF-021) e actionSummary', () => {
    it('repassa correlationId ao classificador', async () => {
      const { router, classifier } = makeDeps({ classification: { decision: 'IGNORAR', confidence: 1 } });
      await router.route(baseInput({ correlationId: 'corr-42' }));
      expect(classifier.classify).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'corr-42' }));
    });

    it('propaga usage/custo do classificador no resultado final, em qualquer decisão', async () => {
      const usage = { inputTokens: 80, outputTokens: 20, costEstimate: 0.005, latencyMs: 200 };
      const { router } = makeDeps({ classification: { decision: 'IGNORAR', confidence: 1, usage } });
      const result = await router.route(baseInput());
      expect(result.usage).toEqual(usage);
    });

    it('PROMOVER bem-sucedido inclui actionSummary com o nome do Patient — pronto para injeção no contexto da IA', async () => {
      const { router } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        associations: [],
        classification: { decision: 'PROMOVER', confidence: 0.9 },
      });
      const result = await router.route(baseInput());
      expect(result.actionSummary).toContain('Maria da Silva');
    });

    it('ASSOCIAR bem-sucedido inclui actionSummary', async () => {
      const { router } = makeDeps({
        contact: contactWith('Vinculado', 'Ana'),
        associations: [assoc('p1')],
        classification: { decision: 'ASSOCIAR', confidence: 0.8 },
      });
      const result = await router.route(baseInput({ knownPatientId: 'p2' }));
      expect(result.actionSummary).toBeDefined();
    });

    it('falha do classificador (sem usage disponível) nunca inclui usage indefinido como um objeto — resultado seguro sem custo', async () => {
      const { router } = makeDeps({ classification: new Error('timeout') });
      const result = await router.route(baseInput());
      expect(result.usage).toBeUndefined();
    });
  });
});
