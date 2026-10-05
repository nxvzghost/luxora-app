import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

/**
 * Endurecimento da borda HTTP — ADR-0057 (Fase 2 da auditoria, R7).
 *
 * As duas funções são chamadas por main.ts e, de forma idêntica, por
 * test/critical/support/bootstrap-app.ts — é o que permite aos Testes
 * Críticos provar os headers e a exposição do Swagger no mesmo código que
 * roda em produção, em vez de numa cópia.
 */
export const SWAGGER_PATH = 'api/v1/docs';

/**
 * A documentação interativa descreve toda a superfície da API (rotas, DTOs,
 * papéis). Fica disponível em desenvolvimento e teste, e NÃO é registrada em
 * produção — a rota simplesmente não existe (404), sem depender de um guard.
 */
export function isSwaggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

/**
 * Headers de segurança do Helmet com a configuração padrão: X-Content-Type-
 * Options, X-Frame-Options, Strict-Transport-Security, Referrer-Policy,
 * Cross-Origin-*, Content-Security-Policy e a remoção de X-Powered-By.
 *
 * A API só responde JSON; a única página HTML é a do Swagger UI, que usa
 * script e estilo inline. Por isso a CSP é relaxada só quando o Swagger
 * está habilitado (nunca em produção, onde vale a CSP padrão do Helmet).
 *
 * Não interfere no CORS do frontend: Cross-Origin-Resource-Policy só se
 * aplica a requisições sem CORS, e o painel chama a API com CORS.
 */
export function applySecurityHeaders(app: INestApplication, env: NodeJS.ProcessEnv = process.env): void {
  app.use(
    helmet(
      isSwaggerEnabled(env)
        ? {
            contentSecurityPolicy: {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'validator.swagger.io'],
              },
            },
          }
        : {},
    ),
  );
}

/** Registra o Swagger UI quando habilitado. Devolve se registrou. */
export function setupSwagger(app: INestApplication, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isSwaggerEnabled(env)) return false;

  const config = new DocumentBuilder()
    .setTitle('Luxora API')
    .setDescription(
      'API oficial da plataforma Luxora — ver docs/04-API/01-Contratos-REST.md para o contrato completo.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(SWAGGER_PATH, app, SwaggerModule.createDocument(app, config));
  return true;
}
