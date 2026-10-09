import { describe, it, expect, vi } from 'vitest';
import {
  ASK_FULL_NAME,
  CLINIC_WILL_CONTINUE,
  ContactIntentActionRouter,
  ContactIntentRoutingInput,
  askNameConfirmation,
} from '@use-cases/contact/contact-intent-action-router';
import { PossibleDuplicatePatientError } from '@use-cases/contact/promover-contato.use-case';
import { ContactIntentClassificationResult } from '@domain-services/ai/contact-intent-classifier';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { Patient } from '@domain/patient/patient.entity';
import { MetricsService } from '@shared/metrics.service';

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
  const identificarContato = { execute: vi.fn().mockResolvedValue(contact) };

  const metrics = new MetricsService();
  const router = new ContactIntentActionRouter(
    classifier as never,
    consultarContato as never,
    promoverContato as never,
    identificarContato as never,
    metrics,
  );
  return { router, consultarContato, classifier, promoverContato, identificarContato, metrics, contact, associations };
}

function baseInput(overrides: Partial<ContactIntentRoutingInput> = {}): ContactIntentRoutingInput {
  return { tenantId: TENANT_ID, contactId: 'c1', conversationHistory: [], message: 'Olá', ...overrides };
}

describe('ContactIntentActionRouter — ADR-0055 (AD-018), regras de identidade da ADR-0063', () => {
  describe('PROMOVER — cadastro só com nome completo e confirmação explícita (AD-037)', () => {
    it('sem nome nenhum: pede o nome completo e não guarda nem cadastra nada', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Conversando', null),
        classification: { decision: 'PROMOVER', confidence: 0.6 },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({ decision: 'PROMOVER', actionTaken: false, requiresConfirmation: true, confirmationPrompt: ASK_FULL_NAME });
      expect(identificarContato.execute).not.toHaveBeenCalled();
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it.each(['Maria', 'M Silva', 'Maria 123', '   '])('nome incompleto ("%s") não é guardado: pede o nome completo de novo', async (hint) => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Conversando', null),
        classification: { decision: 'PROMOVER', confidence: 0.8, patientNameHint: hint },
      });

      const result = await router.route(baseInput());

      expect(result.confirmationPrompt).toBe(ASK_FULL_NAME);
      expect(identificarContato.execute).not.toHaveBeenCalled();
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('nome completo informado: guarda o nome e pede a confirmação — ainda não cadastra', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Conversando', null),
        classification: { decision: 'PROMOVER', confidence: 0.9, patientNameHint: 'Maria da Silva' },
      });

      const result = await router.route(baseInput());

      expect(identificarContato.execute).toHaveBeenCalledWith({ contactId: 'c1', name: 'Maria da Silva' });
      expect(result).toMatchObject({
        decision: 'PROMOVER',
        actionTaken: false,
        requiresConfirmation: true,
        confirmationPrompt: askNameConfirmation('Maria da Silva'),
      });
      expect(result.patientId).toBeUndefined();
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('nome e "confirmo" na MESMA mensagem não cadastram: a confirmação só vale em um turno seguinte', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Conversando', null),
        classification: { decision: 'PROMOVER', confidence: 0.95, patientNameHint: 'Maria da Silva', explicitConfirmation: true },
      });

      const result = await router.route(baseInput());

      expect(identificarContato.execute).toHaveBeenCalledTimes(1);
      expect(result.actionTaken).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('nome já guardado, sem confirmação explícita: pergunta de novo e não cadastra', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.9 },
      });

      const result = await router.route(baseInput());

      expect(result.confirmationPrompt).toBe(askNameConfirmation('Maria da Silva'));
      expect(result.actionTaken).toBe(false);
      expect(identificarContato.execute).not.toHaveBeenCalled();
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it.each([false, undefined, 'true', 1])('explicitConfirmation = %s não é confirmação', async (value) => {
      const { router, promoverContato } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.9, explicitConfirmation: value as never },
      });

      const result = await router.route(baseInput());

      expect(result.actionTaken).toBe(false);
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('nome já guardado e confirmação explícita: cadastra o paciente com o nome guardado', async () => {
      const { router, promoverContato } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.95, explicitConfirmation: true },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({ decision: 'PROMOVER', actionTaken: true, patientId: 'patient-novo' });
      expect(result.requiresConfirmation).toBeUndefined();
      expect(promoverContato.execute).toHaveBeenCalledWith({ contactId: 'c1', patientName: 'Maria da Silva' });
    });

    it('o mesmo nome escrito com outra caixa ou sem acento não é uma correção: a confirmação vale', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Identificado', 'João da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.95, patientNameHint: 'JOAO  da silva', explicitConfirmation: true },
      });

      const result = await router.route(baseInput());

      expect(identificarContato.execute).not.toHaveBeenCalled();
      expect(result.actionTaken).toBe(true);
      expect(promoverContato.execute).toHaveBeenCalledWith({ contactId: 'c1', patientName: 'João da Silva' });
    });

    it('a pessoa corrige o nome antes de confirmar: vale o novo, e a confirmação é pedida de novo', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.9, patientNameHint: 'Mariana da Silva', explicitConfirmation: true },
      });

      const result = await router.route(baseInput());

      expect(identificarContato.execute).toHaveBeenCalledWith({ contactId: 'c1', name: 'Mariana da Silva' });
      expect(result.confirmationPrompt).toBe(askNameConfirmation('Mariana da Silva'));
      expect(result.actionTaken).toBe(false);
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('número que já identifica um paciente nunca abre outro cadastro (D5b)', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Conversando', null),
        classification: { decision: 'PROMOVER', confidence: 0.9, patientNameHint: 'Maria da Silva', explicitConfirmation: true },
      });

      const result = await router.route(baseInput({ knownPatientId: 'p1' }));

      expect(result).toMatchObject({ decision: 'PROMOVER', actionTaken: false });
      expect(result.requiresConfirmation).toBeUndefined();
      expect(identificarContato.execute).not.toHaveBeenCalled();
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('idempotência: PROMOVER num Contact que já tem associação nunca cadastra de novo', async () => {
      const { router, promoverContato } = makeDeps({
        contact: contactWith('Promovido', 'Maria da Silva'),
        associations: [assoc('p1')],
        classification: { decision: 'PROMOVER', confidence: 0.9, explicitConfirmation: true },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({ decision: 'PROMOVER', actionTaken: false });
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('já existe paciente com o mesmo nome: nenhum cadastro, a conversa vai para a clínica e nada é revelado', async () => {
      const { router, promoverContato } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.95, explicitConfirmation: true },
      });
      promoverContato.execute.mockRejectedValueOnce(new PossibleDuplicatePatientError());

      const result = await router.route(baseInput());

      expect(result).toMatchObject({
        decision: 'PROMOVER',
        actionTaken: false,
        escalateToHuman: true,
        handoffReason: 'possible_duplicate',
        patientNotice: CLINIC_WILL_CONTINUE,
      });
      expect(result.patientId).toBeUndefined();
      expect(result.patientNotice).not.toContain('Maria');
      expect(result.error).toBeUndefined();
    });
  });

  describe('ASSOCIAR — nunca associa nem vincula; o caso vai para a clínica (AD-038)', () => {
    it('número que não identifica ninguém dizendo ser de um paciente: pedido de vínculo, nada é feito', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Conversando', null),
        classification: { decision: 'ASSOCIAR', confidence: 0.8, patientNameHint: 'Carla Nunes' },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({
        decision: 'ASSOCIAR',
        actionTaken: false,
        escalateToHuman: true,
        handoffReason: 'link_request',
        patientNotice: CLINIC_WILL_CONTINUE,
      });
      expect(result.patientId).toBeUndefined();
      expect(result.requiresConfirmation).toBeUndefined();
      expect(identificarContato.execute).not.toHaveBeenCalled();
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });

    it('o que a pessoa ouve não repete o nome que ela citou nem diz se esse paciente existe', async () => {
      const { router } = makeDeps({
        contact: contactWith('Conversando', null),
        classification: { decision: 'ASSOCIAR', confidence: 0.8, patientNameHint: 'Carla Nunes' },
      });

      const result = await router.route(baseInput());

      expect(result.patientNotice).not.toContain('Carla');
      expect(result.confirmationPrompt).toBeUndefined();
    });

    it('paciente reconhecido falando de outra pessoa: também vai para a clínica, sem associar ninguém', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        contact: contactWith('Vinculado', 'Ana'),
        associations: [assoc('p1')],
        classification: { decision: 'ASSOCIAR', confidence: 0.8, patientNameHint: 'João' },
      });

      const result = await router.route(baseInput({ knownPatientId: 'p1' }));

      expect(result).toMatchObject({ decision: 'ASSOCIAR', actionTaken: false, escalateToHuman: true, handoffReason: 'human_review' });
      expect(result.patientId).toBeUndefined();
      expect(identificarContato.execute).not.toHaveBeenCalled();
      expect(promoverContato.execute).not.toHaveBeenCalled();
    });
  });

  describe('DESAMBIGUAR', () => {
    it('nunca executa nenhum Use Case — só sinaliza necessidade de confirmação', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        classification: { decision: 'DESAMBIGUAR', confidence: 0.4, reasoning: 'ambíguo' },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({ decision: 'DESAMBIGUAR', actionTaken: false, requiresConfirmation: true });
      expect(promoverContato.execute).not.toHaveBeenCalled();
      expect(identificarContato.execute).not.toHaveBeenCalled();
    });
  });

  describe('IGNORAR — nenhum match', () => {
    it('mensagem sem relação com identidade: nenhuma ação, nenhum Use Case chamado', async () => {
      const { router, promoverContato, identificarContato } = makeDeps({
        classification: { decision: 'IGNORAR', confidence: 0.95 },
      });

      const result = await router.route(baseInput({ message: 'Qual o horário de funcionamento?' }));

      expect(result).toEqual({ decision: 'IGNORAR', actionTaken: false, reasoning: undefined });
      expect(promoverContato.execute).not.toHaveBeenCalled();
      expect(identificarContato.execute).not.toHaveBeenCalled();
    });
  });

  describe('HUMANO', () => {
    it('entrega a conversa à clínica, sem agir', async () => {
      const { router } = makeDeps({
        classification: { decision: 'HUMANO', confidence: 0.3, reasoning: 'situação sensível' },
      });

      const result = await router.route(baseInput());

      expect(result).toMatchObject({
        decision: 'HUMANO',
        actionTaken: false,
        escalateToHuman: true,
        handoffReason: 'human_review',
        patientNotice: CLINIC_WILL_CONTINUE,
      });
    });
  });

  describe('caminhos negativos — falhas nunca viram exceção não tratada nem ação', () => {
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

    it('erro de um Use Case (ex.: transição inválida ao cadastrar) vira falha segura, nunca um cadastro', async () => {
      const { router, promoverContato } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.9, explicitConfirmation: true },
      });
      promoverContato.execute.mockRejectedValueOnce(new Error('InvalidStateTransitionError simulado'));

      const result = await router.route(baseInput());

      expect(result.decision).toBe('HUMANO');
      expect(result.actionTaken).toBe(false);
      expect(result.patientId).toBeUndefined();
      expect(result.error).toContain('InvalidStateTransitionError');
    });
  });

  describe('nunca acessa Repository/Prisma diretamente — só Use Cases + classificador', () => {
    it('as únicas dependências do Router são os 3 Use Cases, o classificador e MetricsService (verificação estrutural)', () => {
      const router = new ContactIntentActionRouter({} as never, {} as never, {} as never, {} as never, new MetricsService());
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

    it('cadastro concluído inclui actionSummary com o nome do Patient — pronto para injeção no contexto da IA', async () => {
      const { router } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.9, explicitConfirmation: true },
      });
      const result = await router.route(baseInput());
      expect(result.actionSummary).toContain('Maria da Silva');
    });

    it('falha do classificador (sem usage disponível) nunca inclui usage indefinido como um objeto — resultado seguro sem custo', async () => {
      const { router } = makeDeps({ classification: new Error('timeout') });
      const result = await router.route(baseInput());
      expect(result.usage).toBeUndefined();
    });
  });

  describe('ADR-0055 (AD-018), Fase 8.2 — métricas de decisão', () => {
    it('cadastro concluído incrementa contact_router_decisions_total{decision=PROMOVER, action_taken=true}', async () => {
      const { router, metrics } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.9, explicitConfirmation: true },
      });
      await router.route(baseInput());
      expect(metrics.getCounter('contact_router_decisions_total', { decision: 'PROMOVER', action_taken: true })).toBe(1);
    });

    it('pedido de confirmação incrementa contact_router_decisions_total{decision=PROMOVER, action_taken=false}', async () => {
      const { router, metrics } = makeDeps({
        contact: contactWith('Identificado', 'Maria da Silva'),
        classification: { decision: 'PROMOVER', confidence: 0.9 },
      });
      await router.route(baseInput());
      expect(metrics.getCounter('contact_router_decisions_total', { decision: 'PROMOVER', action_taken: false })).toBe(1);
    });

    it('ASSOCIAR incrementa contact_router_decisions_total{decision=ASSOCIAR, action_taken=false} — nunca age', async () => {
      const { router, metrics } = makeDeps({
        contact: contactWith('Vinculado', 'Ana'),
        associations: [assoc('p1')],
        classification: { decision: 'ASSOCIAR', confidence: 0.8 },
      });
      await router.route(baseInput({ knownPatientId: 'p1' }));
      expect(metrics.getCounter('contact_router_decisions_total', { decision: 'ASSOCIAR', action_taken: false })).toBe(1);
      expect(metrics.getCounter('contact_router_decisions_total', { decision: 'ASSOCIAR', action_taken: true })).toBe(0);
    });

    it('DESAMBIGUAR incrementa contact_router_decisions_total{decision=DESAMBIGUAR, action_taken=false}', async () => {
      const { router, metrics } = makeDeps({ classification: { decision: 'DESAMBIGUAR', confidence: 0.4 } });
      await router.route(baseInput());
      expect(metrics.getCounter('contact_router_decisions_total', { decision: 'DESAMBIGUAR', action_taken: false })).toBe(1);
    });

    it('HUMANO incrementa contact_router_decisions_total{decision=HUMANO, action_taken=false}', async () => {
      const { router, metrics } = makeDeps({ classification: { decision: 'HUMANO', confidence: 0.3 } });
      await router.route(baseInput());
      expect(metrics.getCounter('contact_router_decisions_total', { decision: 'HUMANO', action_taken: false })).toBe(1);
    });

    it('falha do classificador (caminho negativo) também incrementa a métrica, como HUMANO', async () => {
      const { router, metrics } = makeDeps({ classification: new Error('timeout') });
      await router.route(baseInput());
      expect(metrics.getCounter('contact_router_decisions_total', { decision: 'HUMANO', action_taken: false })).toBe(1);
    });

    it('IGNORAR incrementa contact_router_decisions_total{decision=IGNORAR, action_taken=false}', async () => {
      const { router, metrics } = makeDeps({ classification: { decision: 'IGNORAR', confidence: 0.95 } });
      await router.route(baseInput());
      expect(metrics.getCounter('contact_router_decisions_total', { decision: 'IGNORAR', action_taken: false })).toBe(1);
    });
  });
});
