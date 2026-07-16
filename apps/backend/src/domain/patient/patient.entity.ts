import { StateMachine } from '../shared/state-machine';
import { DomainEvent } from '../shared/domain-event';

/**
 * Estados do Paciente.
 * Fonte: docs/01-Domain/03-Maquina-de-Estados.md, seção "Paciente".
 */
export type PatientState =
  | 'Novo'
  | 'Identificado'
  | 'Cadastrado'
  | 'Ativo'
  | 'Agendado'
  | 'Confirmado'
  | 'EmSessao'
  | 'PagamentoPendente'
  | 'Pago'
  | 'EmFollowUp'
  | 'Inativo'
  | 'Alta';

/**
 * Tabela de transições do Paciente.
 *
 * NOTA DE FIDELIDADE: docs/01-Domain/03-Maquina-de-Estados.md lista os estados
 * possíveis, mas não define explicitamente as transições permitidas entre eles
 * — essa tabela foi inferida a partir da Jornada do Paciente (PRD, JP-001 a
 * JP-015) e das regras de negócio já documentadas (RN-001 a RN-020). Qualquer
 * divergência entre esta inferência e a intenção real do PRD deve ser
 * corrigida aqui E no documento fonte, nunca só no código.
 */
const patientTransitions: Record<PatientState, readonly PatientState[]> = {
  Novo: ['Identificado'],
  Identificado: ['Cadastrado'],
  Cadastrado: ['Ativo'],
  Ativo: ['Agendado', 'EmFollowUp', 'Inativo', 'Alta'],
  Agendado: ['Confirmado', 'Ativo'], // Ativo = cancelamento antes da confirmação
  Confirmado: ['EmSessao', 'Ativo'], // Ativo = cancelamento após confirmação
  EmSessao: ['PagamentoPendente'],
  PagamentoPendente: ['Pago'],
  Pago: ['Ativo', 'EmFollowUp'],
  EmFollowUp: ['Agendado', 'Inativo'],
  Inativo: ['Ativo'], // reativação (JP-013)
  Alta: [], // estado terminal — reingresso exige novo cadastro, não reabertura
};

const patientStateMachine = new StateMachine<PatientState>('Paciente', patientTransitions);

export class PatientStateChangedEvent extends DomainEvent {
  declare readonly fromState: PatientState;
  declare readonly toState: PatientState;

  constructor(entityId: string, tenantId: string, fromState: PatientState, toState: PatientState) {
    super('PacienteEstadoAlterado', entityId, tenantId, { fromState, toState });
  }
}

export interface PatientProps {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  state: PatientState;
  billingPolicyOverride?: 'per_session' | 'weekly' | 'monthly';
}

/**
 * Entidade Paciente — camada de domínio pura.
 * Nunca importa de infrastructure/, api/ ou qualquer framework (Princípio 01, 14).
 */
export class Patient {
  private _state: PatientState;
  private _pendingEvents: DomainEvent[] = [];

  private constructor(private readonly props: PatientProps) {
    this._state = props.state;
  }

  static create(props: Omit<PatientProps, 'state'>): Patient {
    return new Patient({ ...props, state: 'Novo' });
  }

  static reconstitute(props: PatientProps): Patient {
    return new Patient(props);
  }

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get name(): string {
    return this.props.name;
  }

  get phone(): string {
    return this.props.phone;
  }

  get state(): PatientState {
    return this._state;
  }

  get billingPolicyOverride() {
    return this.props.billingPolicyOverride;
  }

  /**
   * Única forma de mudar o estado do Paciente — nunca atribuir _state
   * diretamente de fora desta classe. Gera evento de domínio a cada transição
   * bem-sucedida (Regra Geral do documento de origem).
   */
  transitionTo(newState: PatientState): void {
    patientStateMachine.assertTransition(this._state, newState);
    const previousState = this._state;
    this._state = newState;
    this._pendingEvents.push(
      new PatientStateChangedEvent(this.props.id, this.props.tenantId, previousState, newState),
    );
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }
}
