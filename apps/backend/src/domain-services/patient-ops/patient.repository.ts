import { Patient } from '@domain/patient/patient.entity';

/**
 * PatientRepository — porta (interface). A implementação real (Prisma) vive
 * em infrastructure/, nunca aqui — domain-services/ não pode importar
 * infrastructure/ (regra de dependência arquitetural, ver
 * packages/config/eslint-preset.js).
 */
export interface PatientRepository {
  findById(id: string): Promise<Patient | null>;
  findAllByTenant(params?: { cursor?: string; limit?: number }): Promise<Patient[]>;
  save(patient: Patient): Promise<void>;
  /**
   * ADR-0053 §2.4 — resolve patientId a partir do número de WhatsApp do
   * remetente. Mínimo, determinístico: `phone` não é único hoje (achado de
   * PD-007, dívida pré-existente fora de escopo) — devolve a primeira
   * ocorrência, nunca lança em caso de duplicidade.
   */
  findByPhone(phone: string): Promise<Patient | null>;
  /**
   * ADR-0063 (AD-038) — TODOS os pacientes da clínica cujo telefone é este
   * número (mesma comparação de findByPhone), do cadastro mais antigo para
   * o mais novo. É o que permite saber que um número pertence a mais de um
   * paciente: nesse caso ninguém é escolhido.
   */
  findAllByPhone(phone: string): Promise<Patient[]>;
  /**
   * ADR-0063 (AD-037) — pacientes da clínica com este mesmo nome, comparado
   * sem acento, sem maiúsculas e com espaços simples. Usado para não abrir
   * um segundo cadastro de quem já é paciente e escreve de outro número.
   */
  findAllByName(name: string): Promise<Patient[]>;
  /** Epic 11 — contagem agregada no banco, para GET /dashboard/summary. */
  countActiveByTenant(): Promise<number>;
}

export const PATIENT_REPOSITORY = Symbol('PATIENT_REPOSITORY');
