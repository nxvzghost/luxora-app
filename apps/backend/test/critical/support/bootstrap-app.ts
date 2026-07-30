import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { LuxoraExceptionFilter } from '@shared/luxora-exception.filter';
import { correlationIdMiddleware } from '@shared/correlation-id.middleware';
import { WhatsAppInboundQueueWorker } from '@infrastructure/messaging/whatsapp-inbound-queue.worker';

export interface BootstrapTestAppOptions {
  /**
   * ADR-0054 (AD-036) — ACHADO REAL: a fila 'whatsapp-inbound' é real e
   * compartilhada no mesmo Redis entre TODOS os arquivos da suíte crítica.
   * Como cada arquivo monta seu próprio AppModule via bootstrapTestApp(),
   * cada um instanciava (antes desta opção existir) um
   * WhatsAppInboundQueueWorker real, e todos competiam pelos mesmos jobs
   * — inclusive arquivos que nunca pediram processamento assíncrono
   * algum (ex: whatsapp-webhook.test.ts, deliberadamente escopado só ao
   * webhook síncrono). Um worker de um arquivo processando o job de outro
   * arquivo, sem os mocks/config daquele teste, produz falhas de
   * ambiente disfarçadas de falha de teste.
   *
   * Por padrão (`false`/omitido) o worker real fica DESLIGADO — o
   * provider é substituído por um double inerte, então nenhuma instância
   * de Worker/IORedis chega a existir para aquele app. Só o teste que
   * precisa mesmo exercitar o consumo assíncrono real (hoje, só a suíte
   * da própria AD-036) passa `realWhatsAppInboundWorker: true`. Isso
   * elimina a competição na raiz — sobra exatamente um worker real na
   * suíte inteira — sem exigir nenhuma mudança em código de produção
   * (este arquivo já é exclusivo de teste) e sem desabilitar paralelismo.
   */
  realWhatsAppInboundWorker?: boolean;
}

/**
 * Bootstrap de app real para os Testes Críticos que precisam de HTTP
 * ponta-a-ponta (guards, ValidationPipe, ExceptionFilter — não só Use Case
 * isolado). Espelha main.ts deliberadamente: um teste que não passa pelos
 * mesmos guards/pipes da produção não prova isolamento nenhum.
 *
 * AD-016 — app.use(correlationIdMiddleware) e o exclude de '/metrics' do
 * prefixo global precisam espelhar main.ts exatamente pelo mesmo motivo.
 */
export async function bootstrapTestApp(options: BootstrapTestAppOptions = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (!options.realWhatsAppInboundWorker) {
    builder.overrideProvider(WhatsAppInboundQueueWorker).useValue({});
  }
  const moduleRef = await builder.compile();
  // ADR-0053 — espelha main.ts: rawBody:true, necessário para os testes
  // críticos de WhatsAppWebhookGuard (assinatura HMAC sobre o corpo bruto).
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.use(correlationIdMiddleware);
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new LuxoraExceptionFilter());
  await app.init();
  return app;
}
