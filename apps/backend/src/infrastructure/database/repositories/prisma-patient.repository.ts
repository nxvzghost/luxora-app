import { Injectable } from '@nestjs/common';
import { Patient as PrismaPatient } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Patient, PatientState } from '@domain/patient/patient.entity';
import { PatientRepository } from '@domain-services/patient-ops/patient.repository';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';

/**
 * PrismaPatientRepository — implementação da porta PatientRepository.
 * Único lugar do sistema que converte entre o registro do Prisma e a
 * entidade de Domain — ver ADR-0026 (reconciliação de estados).
 *
 * Toda operação passa por PrismaService.forTenant() — nunca acessa o
 * PrismaClientProvider diretamente (regra reforçada no Módulo 04).
 */
@Injectable()
export class PrismaPatientRepository implements PatientRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Patient | null> {
    const record = await this.prisma.forTenant((tx) => tx.patient.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async findAllByTenant(params?: { cursor?: string; limit?: number }): Promise<Patient[]> {
    const limit = params?.limit ?? 20;
    const records = await this.prisma.forTenant((tx) =>
      tx.patient.findMany({
        take: limit,
        ...(params?.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
      }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async save(patient: Patient): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.patient.upsert({
        where: { id: patient.id },
        create: {
          id: patient.id,
          tenantId: patient.tenantId,
          name: patient.name,
          phone: patient.phone,
          state: patient.state as PrismaPatient['state'],
          billingPolicyOverride: patient.billingPolicyOverride,
        },
        update: {
          name: patient.name,
          state: patient.state as PrismaPatient['state'],
          billingPolicyOverride: patient.billingPolicyOverride,
        },
      }),
    );
  }

  /**
   * Fase 3B da auditoria (ADR-0059) — ACHADO REAL: a busca era por igualdade
   * exata do texto. `patient.phone` é texto livre ("(41) 99999-9999",
   * "+55 41 99999-9999", "41999999999"…) e a Meta entrega o remetente só em
   * dígitos, com o código do país: o paciente já cadastrado não era
   * reconhecido.
   *
   * A comparação agora é entre formas normalizadas. O número procurado passa
   * por PhoneNumber (a regra única, só Brasil) e o valor gravado é comparado
   * só pelos dígitos, contra as duas formas possíveis: com o código do país
   * e sem ele. As duas têm tamanhos diferentes (12–13 e 10–11 dígitos), então
   * uma nunca se confunde com a outra. Um valor gravado que começa com "+"
   * se declara internacional e só é comparado com a forma com código do
   * país — mesma leitura de PhoneNumber.normalize().
   *
   * Nenhum dado gravado é alterado, e a consulta roda dentro de forTenant():
   * a RLS limita a busca à clínica, como em qualquer outra leitura. O índice
   * (tenant_id, phone) não serve a esta consulta — ela percorre os pacientes
   * da clínica, o que só acontece na primeira mensagem de um número novo.
   *
   * Mais de um paciente com o mesmo telefone (familiares): devolve o
   * cadastro mais antigo, de forma estável. Um número que não é do Brasil
   * não é normalizável e cai na comparação exata de antes.
   */
  async findByPhone(phone: string): Promise<Patient | null> {
    const normalized = PhoneNumber.tryNormalize(phone);

    const record = await this.prisma.forTenant(async (tx) => {
      if (!normalized) {
        return tx.patient.findFirst({ where: { phone } });
      }
      const matches = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM patient
        WHERE regexp_replace(phone, '[^0-9]', '', 'g') = ${normalized.toDigits()}
           OR (ltrim(phone) NOT LIKE '+%' AND regexp_replace(phone, '[^0-9]', '', 'g') = ${normalized.toNationalDigits()})
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `;
      return matches.length > 0 ? tx.patient.findUnique({ where: { id: matches[0].id } }) : null;
    });

    return record ? this.toDomain(record) : null;
  }

  async countActiveByTenant(): Promise<number> {
    return this.prisma.forTenant((tx) => tx.patient.count({ where: { state: 'Ativo' } }));
  }

  private toDomain(record: PrismaPatient): Patient {
    return Patient.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      name: record.name,
      phone: record.phone,
      state: record.state as PatientState,
      billingPolicyOverride: record.billingPolicyOverride ?? undefined,
    });
  }
}
