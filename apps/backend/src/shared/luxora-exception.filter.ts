import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { CORRELATION_ID_REQUEST_KEY, type RequestWithCorrelationId } from './correlation-context';

type ErrorCategory = 'validation' | 'business_rule' | 'authorization' | 'not_found' | 'rate_limit' | 'system';

/**
 * LuxoraExceptionFilter — Módulo 08 (API Layer).
 * Fonte: 02 - CTO/clinicos/docs/04-API/00-Principios-da-API.md.
 *
 * GAP REAL: até este módulo, toda exceção (NotFoundException,
 * ConflictException, ValidationPipe) saía no formato padrão do NestJS,
 * nunca no formato documentado desde o Módulo 01
 * ({ error: { code, message, category, timestamp } }).
 */
@Catch()
export class LuxoraExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(LuxoraExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    // AD-016 — este filtro é instanciado manualmente em main.ts
    // (`new LuxoraExceptionFilter()`), não via DI do Nest, então não pode
    // injetar CorrelationContext (Scope.REQUEST). Lê direto do req cru, já
    // preenchido pelo correlationIdMiddleware antes de qualquer Guard rodar.
    const request = ctx.getRequest<RequestWithCorrelationId>();
    const correlationId = request[CORRELATION_ID_REQUEST_KEY] ?? null;
    const { status, code, message, category } = this.normalize(exception);

    // BUG REAL ENCONTRADO E CORRIGIDO: a mensagem "Nossa equipe foi
    // notificada" era mentira — nenhuma exceção não mapeada era logada em
    // lugar nenhum, tornando todo erro 500 uma caixa-preta sem rastro
    // nenhum para diagnosticar depois.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[correlationId=${correlationId ?? 'desconhecido'}] ${exception instanceof Error ? exception.stack ?? exception.message : String(exception)}`,
      );
    }

    response.status(status).json({ error: { code, message, category, timestamp: new Date().toISOString(), correlationId } });
  }

  private normalize(exception: unknown): { status: number; code: string; message: string; category: ErrorCategory } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'object' && body !== null && 'code' in body) {
        const b = body as { code: string; message?: string; category?: ErrorCategory };
        return { status, code: b.code, message: b.message ?? exception.message, category: b.category ?? this.categoryForStatus(status) };
      }

      const rawMessage = typeof body === 'object' && body !== null && 'message' in body
        ? (body as { message: string | string[] }).message
        : exception.message;
      const message = Array.isArray(rawMessage) ? rawMessage.join('; ') : rawMessage;

      return { status, code: this.codeForStatus(status, exception.constructor.name), message, category: this.categoryForStatus(status) };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Ocorreu um erro inesperado. Nossa equipe foi notificada.',
      category: 'system',
    };
  }

  private categoryForStatus(status: number): ErrorCategory {
    if (status === HttpStatus.BAD_REQUEST) return 'validation';
    if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) return 'authorization';
    if (status === HttpStatus.NOT_FOUND) return 'not_found';
    if (status === HttpStatus.CONFLICT) return 'business_rule';
    // AD-006 — ThrottlerException (@nestjs/throttler) sempre usa este status.
    if (status === HttpStatus.TOO_MANY_REQUESTS) return 'rate_limit';
    return 'system';
  }

  private codeForStatus(status: number, exceptionClassName: string): string {
    const known: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
      [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
      [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
      [HttpStatus.CONFLICT]: 'CONFLICT',
      [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
    };
    return known[status] ?? exceptionClassName.replace('Exception', '').toUpperCase();
  }
}
