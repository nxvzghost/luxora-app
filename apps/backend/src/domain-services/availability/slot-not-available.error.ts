import { ConflictException } from '@nestjs/common';

/**
 * SlotNotAvailableError — o Motor de Disponibilidade (ADR-0040) recusou o
 * horário. Distinto de SESSION_CONFLICT (índice único do banco, corrida
 * entre duas requisições concorrentes): este erro significa que o horário
 * nunca esteve disponível para começar — fora da janela do Terapeuta, ou já
 * ocupado por outro Appointment ativo no momento da consulta ao Motor.
 */
export class SlotNotAvailableError extends ConflictException {
  constructor() {
    super({
      code: 'SLOT_NOT_AVAILABLE',
      message: 'O horário selecionado não está disponível.',
      category: 'business_rule',
    });
  }
}
