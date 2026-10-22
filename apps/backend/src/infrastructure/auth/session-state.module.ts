import { Global, Module } from '@nestjs/common';
import { SessionStateCache } from './session-state.cache';

/**
 * ADR-0067 — global porque o `JwtAuthGuard` é declarado nos providers de
 * cada módulo que o usa (doze hoje): todos precisam do mesmo cache, com uma
 * única conexão com o Redis.
 */
@Global()
@Module({
  providers: [SessionStateCache],
  exports: [SessionStateCache],
})
export class SessionStateModule {}
