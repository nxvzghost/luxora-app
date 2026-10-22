import { Global, Module } from '@nestjs/common';
import { PrismaClientProvider } from './prisma-client.provider';

/**
 * DatabaseModule — Global() de propósito, como TenantContextModule.
 *
 * DEFEITO REAL CORRIGIDO: PrismaClientProvider era declarado como provider
 * LOCAL em 17 módulos (audit, auth, ai, appointments, automations, billing,
 * clinic, communication, contact, dashboard, inbox, notification, patients,
 * session-state, subscription, therapists, users). O Nest cria uma instância
 * por módulo que declara o provider, e cada instância é um PrismaClient com
 * pool próprio: o ensaio de deploy media 17 conexões logo após o boot, uma
 * por cliente, e cada pool podia crescer até o connection_limit. Na Suíte
 * Crítica (4 arquivos em paralelo, connection_limit=4) isso passava do limite
 * do Postgres e derrubou o CI 39737046589 com "Too many database connections".
 *
 * Este módulo é o único lugar que declara PrismaClientProvider: uma instância
 * para a aplicação inteira, um pool, um $connect no boot e um $disconnect no
 * encerramento. Basta importá-lo uma vez em AppModule; os outros módulos
 * recebem o cliente pela exportação global e não devem declará-lo (ver
 * test/unit/infrastructure/database/prisma-client-single-declaration.test.ts).
 */
@Global()
@Module({
  providers: [PrismaClientProvider],
  exports: [PrismaClientProvider],
})
export class DatabaseModule {}
