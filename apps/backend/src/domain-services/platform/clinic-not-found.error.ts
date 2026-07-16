import { NotFoundException } from '@nestjs/common';

/**
 * ClinicNotFoundError — vive em domain-services/, não em infrastructure/.
 *
 * Encontrado durante o Módulo 06: a primeira versão desta classe estava em
 * infrastructure/database/repositories/, e use-cases/ importava de lá —
 * violação direta da regra de dependência arquitetural (use-cases nunca
 * pode importar infrastructure, ver packages/config/eslint-preset.js).
 * O erro em si é um conceito de domínio (a Clínica não foi encontrada),
 * não um detalhe de infraestrutura — por isso pertence aqui.
 */
export class ClinicNotFoundError extends NotFoundException {
  constructor() {
    super('Clínica não encontrada ou configuração incompleta.');
  }
}
