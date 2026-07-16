import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { LuxoraExceptionFilter } from '@shared/luxora-exception.filter';

/**
 * Luxora — Backend entry point.
 *
 * Princípio 21 (Motor Operacional): nenhuma requisição chega a um Serviço de
 * Domínio sem antes passar pelo Motor Operacional. Este bootstrap não sabe
 * disso diretamente — a garantia vive na estrutura de módulos (ver
 * src/api/*.module.ts, que sempre depende de OperationalEngineModule).
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  app.setGlobalPrefix('api/v1');

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
