import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { LuxoraExceptionFilter } from '@shared/luxora-exception.filter';
import { correlationIdMiddleware } from '@shared/correlation-id.middleware';

/**
 * Bootstrap de app real para os Testes Críticos que precisam de HTTP
 * ponta-a-ponta (guards, ValidationPipe, ExceptionFilter — não só Use Case
 * isolado). Espelha main.ts deliberadamente: um teste que não passa pelos
 * mesmos guards/pipes da produção não prova isolamento nenhum.
 *
 * AD-016 — app.use(correlationIdMiddleware) e o exclude de '/metrics' do
 * prefixo global precisam espelhar main.ts exatamente pelo mesmo motivo.
 */
export async function bootstrapTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(correlationIdMiddleware);
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new LuxoraExceptionFilter());
  await app.init();
  return app;
}
