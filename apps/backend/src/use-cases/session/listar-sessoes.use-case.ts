import { Injectable, Inject } from '@nestjs/common';
import { SESSION_REPOSITORY, SessionFilter, SessionRepository, SessionSummary } from '@domain-services/patient-ops/session.repository';

/**
 * ListarSessoesUseCase — Tarefa 05 da auditoria (frontend operável).
 *
 * Só leitura. Existe porque gerar uma cobrança exige os ids das sessões
 * (POST /billings, `sessionIds`), e nenhuma rota permitia descobri-los: o
 * painel não tinha como oferecer "criar cobrança" (AD-020).
 *
 * Devolve as sessões da clínica da requisição — o isolamento é o mesmo de
 * todo o resto, pela Row-Level Security.
 *
 * K2-b (ADR-0069, seção 7) — `state=Realizada` ("a faturar") devolve só as
 * sessões que podem entrar numa cobrança nova: com o que cobrar, elegíveis e
 * não anuladas. As legadas, criadas pela confirmação, continuam lá, mas não
 * são oferecidas para cobrança (DP-27).
 */
@Injectable()
export class ListarSessoesUseCase {
  constructor(@Inject(SESSION_REPOSITORY) private readonly repo: SessionRepository) {}

  async execute(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    return this.repo.findSummaries(filter.state === 'Realizada' ? { ...filter, billableOnly: true } : filter);
  }
}
