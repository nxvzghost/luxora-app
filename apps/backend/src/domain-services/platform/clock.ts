/**
 * Clock — porta (interface). K2-b (ADR-0069, seção 8: "pré-requisito: porta
 * Clock para as fronteiras exatas").
 *
 * As regras do ciclo da consulta dependem do instante exato do início
 * previsto (confirmar e cancelar só antes; realização e falta só no início
 * ou depois). Os casos de uso leem o relógio por aqui, para que os testes
 * fixem o instante em vez de depender da hora em que rodam.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');
