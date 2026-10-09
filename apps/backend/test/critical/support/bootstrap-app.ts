import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { LuxoraExceptionFilter } from '@shared/luxora-exception.filter';
import { correlationIdMiddleware } from '@shared/correlation-id.middleware';
import { applySecurityHeaders, setupSwagger } from '@shared/http-hardening';
import { WhatsAppInboundQueueWorker } from '@infrastructure/messaging/whatsapp-inbound-queue.worker';
import { MessageQueueWorker } from '@infrastructure/messaging/message-queue.worker';

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
  /**
   * Fase 3 da auditoria — mesmo raciocínio, para a fila de saída
   * 'messages'. Desde que MessageQueueWorker passou a ser instanciado de
   * fato, cada app de teste subiria um consumidor real dessa fila, que
   * tentaria ENVIAR pela Graph API da Meta qualquer job enfileirado por
   * qualquer arquivo da suíte. Por padrão fica desligado; só a suíte que
   * prova o consumo da fila de saída pede o worker real — e ela mesma
   * intercepta `fetch`, então nenhuma chamada sai da máquina.
   */
  realMessageQueueWorker?: boolean;
  /**
   * Tarefa 06 da auditoria — substitui providers por dublês do próprio
   * teste. Existe para os testes do fluxo de Contact, que trocam só o que é
   * externo ou compartilhado: o provedor de IA e o classificador (Anthropic)
   * por respostas roteirizadas, e o produtor da fila de entrada por um que
   * guarda o job em memória — para nenhum job deste teste cair na fila real
   * que o worker de outro arquivo consome. Todo o resto continua real.
   *
   * ADR-0063 (AD-038) — `useClass` troca o provider por uma classe que o Nest
   * instancia com as dependências reais. Serve para os testes de
   * concorrência da aprovação de vínculo: a classe ESTENDE o repositório real
   * e só acrescenta pontos de espera e de falha — o SQL executado é o de
   * produção.
   */
  overrides?: Array<{ provide: unknown; useValue: unknown } | { provide: unknown; useClass: new (...args: never[]) => unknown }>;
}

/**
 * Bootstrap de app real para os Testes Críticos que precisam de HTTP
 * ponta-a-ponta (guards, ValidationPipe, ExceptionFilter — não só Use Case
 * isolado). Espelha main.ts deliberadamente: um teste que não passa pelos
 * mesmos guards/pipes da produção não prova isolamento nenhum.
 *
 * AD-016 — app.use(correlationIdMiddleware) e o exclude de '/metrics' do
 * prefixo global precisam espelhar main.ts exatamente pelo mesmo motivo.
 *
 * ADR-0057 — applySecurityHeaders() e setupSwagger() são as MESMAS funções
 * chamadas por main.ts, na mesma ordem; ambas leem NODE_ENV no momento da
 * chamada, então um teste pode subir o app "como produção" definindo
 * NODE_ENV antes de chamar bootstrapTestApp().
 */
export async function bootstrapTestApp(options: BootstrapTestAppOptions = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (!options.realWhatsAppInboundWorker) {
    builder.overrideProvider(WhatsAppInboundQueueWorker).useValue({});
  }
  if (!options.realMessageQueueWorker) {
    builder.overrideProvider(MessageQueueWorker).useValue({});
  }
  for (const override of options.overrides ?? []) {
    if ('useClass' in override) {
      builder.overrideProvider(override.provide).useClass(override.useClass);
    } else {
      builder.overrideProvider(override.provide).useValue(override.useValue);
    }
  }
  const moduleRef = await builder.compile();
  // ADR-0053 — espelha main.ts: rawBody:true, necessário para os testes
  // críticos de WhatsAppWebhookGuard (assinatura HMAC sobre o corpo bruto).
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.use(correlationIdMiddleware);
  applySecurityHeaders(app);
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new LuxoraExceptionFilter());
  setupSwagger(app);
  await app.init();
  return app;
}
