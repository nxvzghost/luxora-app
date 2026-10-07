import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Response } from 'express';
import { HealthController } from '@api/health.controller';
import type { ReadinessReport, ReadinessService } from '@infrastructure/health/readiness.service';

/**
 * Tarefa 04 da auditoria — as duas sondas. O liveness nunca consulta
 * dependência; o readiness devolve 503 sempre que a instância não pode
 * receber tráfego.
 */

function controllerWith(report: ReadinessReport) {
  const check = vi.fn().mockResolvedValue(report);
  const status = vi.fn();
  const controller = new HealthController({ check } as unknown as ReadinessService);
  return { controller, check, status, response: { status } as unknown as Response };
}

afterEach(() => {
  delete process.env.APP_VERSION;
});

describe('HealthController', () => {
  it('liveness responde sem consultar dependência nenhuma', () => {
    const { controller, check } = controllerWith({ status: 'not_ready', checks: { database: 'down', redis: 'down' } });

    const body = controller.check();

    expect(body.status).toBe('ok');
    expect(body.service).toBe('luxora-backend');
    expect(check).not.toHaveBeenCalled();
  });

  it('liveness informa a versão em execução (APP_VERSION), e "dev" quando ela não existe', () => {
    const { controller } = controllerWith({ status: 'ready', checks: { database: 'up', redis: 'up' } });

    expect(controller.check().version).toBe('dev');

    process.env.APP_VERSION = '94a955a';
    expect(controller.check().version).toBe('94a955a');
  });

  it('readiness pronto: devolve o relatório e mantém o 200', async () => {
    const report: ReadinessReport = { status: 'ready', checks: { database: 'up', redis: 'up' } };
    const { controller, status, response } = controllerWith(report);

    await expect(controller.ready(response)).resolves.toEqual(report);
    expect(status).not.toHaveBeenCalled();
  });

  it.each<ReadinessReport>([
    { status: 'not_ready', checks: { database: 'down', redis: 'up' } },
    { status: 'shutting_down' },
  ])('readiness $status: 503, com o relatório no corpo', async (report) => {
    const { controller, status, response } = controllerWith(report);

    await expect(controller.ready(response)).resolves.toEqual(report);
    expect(status).toHaveBeenCalledWith(503);
  });
});
