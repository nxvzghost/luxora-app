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
 */
@Injectable()
export class ListarSessoesUseCase {
  constructor(@Inject(SESSION_REPOSITORY) private readonly repo: SessionRepository) {}

  async execute(filter: SessionFilter = {}): Promise<SessionSummary[]> {
    return this.repo.findSummaries(filter);
  }
}
