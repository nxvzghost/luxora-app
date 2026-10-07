import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReadinessReport, ReadinessService } from '@infrastructure/health/readiness.service';

/**
 * Health-check — não requer autenticação (é usado por probes de infraestrutura).
 * Único endpoint permitido fora do padrão de autenticação obrigatória do
 * restante da API, por natureza operacional.
 *
 * Duas sondas, com perguntas diferentes (Tarefa 04 da auditoria):
 *   GET /health        liveness  — o processo está de pé? Nunca consulta
 *                                  dependência: se falhar, reinicia-se o container.
 *   GET /health/ready  readiness — pode receber tráfego? Consulta Postgres e
 *                                  Redis: se falhar, só se tira a instância
 *                                  do balanceamento.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  check() {
    return {
      status: 'ok',
      service: 'luxora-backend',
      // Identificador da versão em execução, gravado na imagem no build
      // (APP_VERSION). É o que o deploy e o rollback conferem depois de trocar
      // a versão; "dev" fora de uma imagem.
      version: process.env.APP_VERSION ?? 'dev',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (report.status !== 'ready') response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
