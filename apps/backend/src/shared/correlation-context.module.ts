import { Global, Module } from '@nestjs/common';
import { CorrelationContext } from './correlation-context';

/**
 * CorrelationContextModule — AD-016, mesmo padrão de TenantContextModule
 * (@Global(), uma única instância por requisição compartilhada por todo o
 * grafo de módulos). Ver correlation-context.ts para a justificativa de por
 * que este é um contexto dedicado, não uma extensão de TenantContext.
 */
@Global()
@Module({
  providers: [CorrelationContext],
  exports: [CorrelationContext],
})
export class CorrelationContextModule {}
