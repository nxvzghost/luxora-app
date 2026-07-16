import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/**
 * Health-check — não requer autenticação (é usado por probes de infraestrutura).
 * Único endpoint permitido fora do padrão de autenticação obrigatória do
 * restante da API, por natureza operacional.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'luxora-backend',
      timestamp: new Date().toISOString(),
    };
  }
}
