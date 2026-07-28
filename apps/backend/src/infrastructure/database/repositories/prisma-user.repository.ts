import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { User as PrismaUser, Prisma, PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { User, AssignableUserRole } from '@domain/user/user.entity';
import { UserRepository } from '@domain-services/platform/user.repository';
import { DomainEvent } from '@domain/shared/domain-event';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PrismaUserRepository — AD-001. Deliberadamente NÃO usa `PrismaService`
 * (que lê `tenantId` de `TenantContext`, implícito e request-scoped) — mesma
 * razão de `PrismaClinicHolidayRepository`: `provisionFirstAdmin()` roda
 * antes de qualquer `TenantContext` existir, e manter um único padrão de
 * acesso (tenantId explícito + `SET LOCAL` na própria transação) evita duas
 * formas diferentes de acessar o mesmo dado dentro da mesma classe.
 */
@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly clientProvider: PrismaClientProvider) {}

  async findById(tenantId: string, userId: string): Promise<User | null> {
    const record = await this.withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { id: userId, tenantId } }),
    );
    return record ? this.toDomain(record) : null;
  }

  async findAllByTenant(tenantId: string): Promise<User[]> {
    const records = await this.withTenant(tenantId, (tx) =>
      tx.user.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async save(user: User): Promise<void> {
    try {
      await this.withTenant(user.tenantId, (tx) =>
        tx.user.upsert({
          where: { id: user.id },
          create: {
            id: user.id,
            tenantId: user.tenantId,
            email: user.email,
            passwordHash: user.passwordHash,
            role: user.role,
            therapistId: user.therapistId,
          },
          update: {
            role: user.role,
            therapistId: user.therapistId,
            deletedAt: user.deletedAt,
          },
        }),
      );
    } catch (error) {
      // ADR-0024 — e-mail globalmente único. P2002 é o código do Prisma para
      // violação de constraint única — traduzido para o formato oficial de
      // erro da API (ConflictException -> 409), nunca vazado como 500 cru.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Este e-mail já está em uso.');
      }
      throw error;
    }
  }

  /**
   * AD-001 — atômico e seguro sob concorrência real: `SELECT ... FOR UPDATE`
   * no próprio `tenant` (tabela deliberadamente FORA da RLS — ver
   * `enable-rls.sql`, "todas exceto tenant em si" — então não precisa de
   * `app.tenant_id` para ser lida) serializa duas chamadas simultâneas para
   * o mesmo Tenant: a segunda espera a primeira commitar, então enxerga a
   * contagem de usuários já atualizada — nunca as duas veem "0 usuários" ao
   * mesmo tempo. `app.tenant_id` é definido para o próprio Tenant sendo
   * provisionado (nunca um bypass) — a policy `tenant_isolation` de `user`
   * (sem `FOR`, cobre SELECT e INSERT) exige isso tanto para o `count()`
   * quanto para o `create()` subsequente. Sem isolamento SERIALIZABLE nem
   * migration nova: o lock de linha no `tenant` já é suficiente para a
   * garantia exigida (nunca 2 admins para o mesmo Tenant).
   *
   * ACHADO REAL DURANTE A IMPLEMENTAÇÃO (não hipotético): `AuditService.
   * recordAll()` não pode ser chamado aqui — `PrismaAuditLogRepository.
   * record()` usa `PrismaService.forTenant()` incondicionalmente, que lê
   * `TenantContext.tenantId` e lança erro se não inicializado (nunca é,
   * neste fluxo público sem JwtAuthGuard). Em vez de violar a regra "só
   * Guards chamam TenantContext.set()" para contornar isso, o evento de
   * auditoria é escrito diretamente, na MESMA transação (mesmo tenantId já
   * confirmado acima) — mais forte que o padrão usual (`AuditService`
   * chamado depois, como um passo separado): a criação do usuário e seu
   * registro de auditoria agora são atômicos entre si, nunca um sem o
   * outro.
   */
  async provisionFirstAdmin(tenantId: string, user: User): Promise<void> {
    if (!UUID_REGEX.test(tenantId)) {
      throw new NotFoundException('Tenant não encontrado.');
    }

    try {
      await this.clientProvider.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);

        // "id" é TEXT no Postgres (String @default(uuid()) do Prisma nunca vira
        // o tipo nativo uuid) — SEM cast é o comportamento correto, mesma nota
        // já registrada em enable-rls.sql sobre tenant_id (o cast ::uuid quebra
        // com "operator does not exist: text = uuid").
        const tenantRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "tenant" WHERE id = ${tenantId} AND deleted_at IS NULL FOR UPDATE
        `;
        if (tenantRows.length === 0) {
          throw new NotFoundException('Tenant não encontrado.');
        }

        const userCount = await tx.user.count({ where: { tenantId } });
        if (userCount > 0) {
          throw new ConflictException('Este Tenant já possui um administrador provisionado.');
        }

        await tx.user.create({
          data: {
            id: user.id,
            tenantId: user.tenantId,
            email: user.email,
            passwordHash: user.passwordHash,
            role: user.role,
          },
        });

        for (const event of user.pullDomainEvents()) {
          await tx.auditLog.create({
            data: {
              id: randomUUID(),
              tenantId: event.tenantId,
              userId: null,
              actorType: 'system',
              action: event.eventName,
              entityType: event.constructor.name.replace('Event', ''),
              entityId: event.entityId,
              payload: this.extractEventPayload(event) as Prisma.InputJsonValue,
              result: 'success',
            },
          });
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Este e-mail já está em uso.');
      }
      throw error;
    }
  }

  /** Mesma extração de `AuditService.extractPayload()` — duplicada aqui deliberadamente, ver nota de `provisionFirstAdmin()` sobre por que este caminho não pode reaproveitar `AuditService` diretamente. */
  private extractEventPayload(event: DomainEvent): Record<string, unknown> {
    const { eventName: _e, entityId: _id, tenantId: _t, occurredAt: _o, ...rest } = event as unknown as Record<
      string,
      unknown
    >;
    return rest;
  }

  private async withTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    if (!UUID_REGEX.test(tenantId)) {
      throw new Error(`tenantId em formato inválido, recusando executar query: ${tenantId}`);
    }
    return this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      return fn(tx as PrismaClient);
    });
  }

  private toDomain(record: PrismaUser): User {
    return User.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      email: record.email,
      passwordHash: record.passwordHash,
      role: record.role as AssignableUserRole,
      therapistId: record.therapistId ?? undefined,
      deletedAt: record.deletedAt,
    });
  }
}
