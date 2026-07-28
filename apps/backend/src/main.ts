import './tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { LuxoraExceptionFilter } from '@shared/luxora-exception.filter';
import { correlationIdMiddleware } from '@shared/correlation-id.middleware';

/**
 * Luxora — Backend entry point.
 *
 * Princípio 21 (Motor Operacional): nenhuma requisição chega a um Serviço de
 * Domínio sem antes passar pelo Motor Operacional. Este bootstrap não sabe
 * disso diretamente — a garantia vive na estrutura de módulos (ver
 * src/api/*.module.ts, que sempre depende de OperationalEngineModule).
 */
async function bootstrap() {
  // ADR-0053 — rawBody:true expõe request.rawBody (Buffer) em toda rota,
  // necessário para WhatsAppWebhookGuard verificar a assinatura
  // HMAC-SHA256 (X-Hub-Signature-256) sobre os bytes exatos que a Meta
  // enviou — um JSON re-serializado a partir do corpo já parseado não tem
  // garantia de ser byte-idêntico. Mecanismo nativo do Nest, não custom
  // middleware — nenhuma outra rota é afetada.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // AD-016 — precisa ser o primeiro app.use(): roda antes de qualquer Guard
  // (inclusive JwtAuthGuard/ThrottlerGuard), garantindo que até respostas de
  // erro (401/403/429) já tenham um Correlation ID. Ver
  // shared/correlation-id.middleware.ts para o porquê de ser um middleware
  // Express puro, não um Guard/Interceptor do Nest.
  app.use(correlationIdMiddleware);

  // AD-006 — necessário para que req.ip (usado pelo ThrottlerGuard de
  // POST /auth/login) reflita o IP real do cliente, não o do reverse
  // proxy (Railway, produção — docs/07-Infra/00-Provedor-e-Custos.md).
  // "1" = confia apenas no primeiro hop à frente da aplicação (o proxy de
  // borda), não em qualquer proxy encadeado — suficiente para a topologia
  // atual (um único proxy entre o cliente e este processo).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // BUG REAL ENCONTRADO E CORRIGIDO: nenhum CORS configurado — o navegador
  // bloqueava toda chamada do frontend (localhost:3001/3002) para o backend
  // (localhost:3000), origens diferentes, com o preflight OPTIONS batendo
  // numa rota inexistente (404) antes mesmo do POST real ser tentado.
  // FRONTEND_URL aceita uma lista separada por vírgula, para cobrir os
  // 3001/3002 que o Next escolhe automaticamente quando a porta padrão
  // está ocupada (ver COMECE_AQUI.md).
  const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:3001,http://localhost:3002')
    .split(',')
    .map((origin) => origin.trim());
  app.enableCors({ origin: allowedOrigins, credentials: true });

  // AD-016 — /metrics fica fora do prefixo versionado: convenção padrão de
  // scrapers Prometheus, que esperam um path fixo (ver
  // api/metrics/metrics.controller.ts). Protegido por MetricsAccessGuard,
  // nunca uma rota pública.
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });

  // ValidationPipe global — sem isso, os decorators de class-validator nos
  // DTOs (ex: LoginDto) são apenas metadados sem efeito, nunca validados de
  // fato. whitelist:true também descarta silenciosamente qualquer campo não
  // declarado no DTO — reforça o princípio de nunca aceitar input não
  // esperado (ex: um tenantId enviado por engano/má-fé no body).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Módulo 08: todo erro sai no formato oficial documentado
  // (04-API/00-Principios-da-API.md) — nunca no formato padrão do NestJS.
  app.useGlobalFilters(new LuxoraExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('Luxora API')
    .setDescription(
      'API oficial da plataforma Luxora — ver docs/04-API/01-Contratos-REST.md para o contrato completo.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Luxora backend rodando na porta ${port}`);
}

bootstrap();
