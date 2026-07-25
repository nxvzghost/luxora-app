import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MetricsAccessGuard } from './metrics-access.guard';
import { prometheusExporter } from '../../tracing';

/**
 * MetricsController — AD-016.
 *
 * Exposto em /metrics, fora do prefixo global api/v1 (ver main.ts,
 * setGlobalPrefix com `exclude` — convenção padrão de scrapers Prometheus,
 * que esperam um path fixo e não-versionado). Delega inteiramente ao
 * PrometheusExporter registrado como metric reader do NodeSDK em
 * tracing.ts — este controller só decide ONDE a rota fica e QUEM pode
 * acessá-la (MetricsAccessGuard), nunca serializa métricas ele mesmo.
 */
@ApiExcludeController()
@UseGuards(MetricsAccessGuard)
@Controller('metrics')
export class MetricsController {
  @Get()
  getMetrics(@Req() req: Request, @Res() res: Response): void {
    prometheusExporter.getMetricsRequestHandler(req, res);
  }
}
