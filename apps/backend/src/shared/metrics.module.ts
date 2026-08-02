import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * MetricsModule — ADR-0055 (AD-018), Fase 8.2. Mesmo padrão de
 * TenantContextModule/CorrelationContextModule: @Global(), uma única
 * instância de MetricsService compartilhada por todo o grafo de módulos,
 * registrada uma vez em AppModule — nenhum outro módulo precisa importá-la
 * para injetar MetricsService.
 */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
