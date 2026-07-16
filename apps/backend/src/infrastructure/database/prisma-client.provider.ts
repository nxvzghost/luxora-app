import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaClientProvider — o ÚNICO PrismaClient da aplicação, singleton.
 *
 * Corrige um defeito real encontrado no Módulo 04 (Multi-Tenant): a versão
 * anterior de PrismaService era `Scope.REQUEST` e estendia PrismaClient
 * diretamente — ou seja, cada requisição HTTP abria um pool de conexões
 * novo com o Postgres. Sob carga real concorrente, isso esgotaria as
 * conexões do banco rapidamente, um bug de escala grave escondido atrás de
 * uma lógica de RLS que, isoladamente, estava correta.
 *
 * O isolamento por Tenant não depende de ter uma conexão por requisição —
 * depende de `SET LOCAL app.tenant_id` dentro de uma transação (ver
 * PrismaService.forTenant()), que funciona perfeitamente sobre um cliente
 * compartilhado com pool de conexões gerenciado normalmente pelo Prisma.
 */
@Injectable()
export class PrismaClientProvider extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
