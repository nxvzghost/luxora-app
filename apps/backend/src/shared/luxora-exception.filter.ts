import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

type ErrorCategory = 'validation' | 'business_rule' | 'authorization' | 'not_found' | 'system';

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
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const { status, code, message, category } = this.normalize(exception);
    response.status(status).json({ error: { code, message, category, timestamp: new Date().toISOString() } });
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
    return 'system';
  }

  private codeForStatus(status: number, exceptionClassName: string): string {
    const known: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
      [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
      [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
      [HttpStatus.CONFLICT]: 'CONFLICT',
    };
    return known[status] ?? exceptionClassName.replace('Exception', '').toUpperCase();
  }
}
