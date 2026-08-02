import { Injectable, Logger } from '@nestjs/common';

/**
 * MetricsService — ADR-0055 (AD-018), Fase 8.2.
 *
 * Instrumentação puramente interna ao projeto — sem Prometheus, sem
 * OpenTelemetry, sem infraestrutura externa (decisão explícita desta
 * fase). Agregação em memória (processo único, reiniciada a cada deploy —
 * suficiente para o objetivo desta fase: observabilidade OPERACIONAL via
 * log estruturado, não um sistema de séries temporais). Cada gravação
 * também sai como log estruturado (`[metric] ...`), a mesma via de
 * observabilidade já usada no resto do projeto (correlationId em log),
 * então já é visível em produção sem esperar nenhuma infraestrutura nova.
 *
 * Labels nunca devem carregar valores de cardinalidade alta/ilimitada
 * (nunca tenantId, contactId, patientId, correlationId) — só valores de
 * um conjunto pequeno e fixo (ex.: call_type, outcome, decision). Isso é
 * deliberado: evita crescimento sem limite do Map em memória.
 */
export type MetricLabels = Record<string, string | number | boolean | undefined>;

export interface ObservationStats {
  count: number;
  sum: number;
  min: number;
  max: number;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, ObservationStats>();

  incrementCounter(name: string, labels: MetricLabels = {}, value = 1): number {
    const key = this.buildKey(name, labels);
    const next = (this.counters.get(key) ?? 0) + value;
    this.counters.set(key, next);
    this.logger.log(`[metric] counter ${name}${this.formatLabels(labels)} +${value} total=${next}`);
    return next;
  }

  /** Genérico — usado tanto para duração (ms) quanto para custo (BRL): ambos são só uma distribuição numérica com count/sum/min/max. */
  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const key = this.buildKey(name, labels);
    const existing = this.observations.get(key);
    const next: ObservationStats = existing
      ? { count: existing.count + 1, sum: existing.sum + value, min: Math.min(existing.min, value), max: Math.max(existing.max, value) }
      : { count: 1, sum: value, min: value, max: value };
    this.observations.set(key, next);
    this.logger.log(
      `[metric] observe ${name}${this.formatLabels(labels)} value=${value} count=${next.count} avg=${(next.sum / next.count).toFixed(4)}`,
    );
  }

  getCounter(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(this.buildKey(name, labels)) ?? 0;
  }

  getObservationStats(name: string, labels: MetricLabels = {}): ObservationStats | undefined {
    return this.observations.get(this.buildKey(name, labels));
  }

  private buildKey(name: string, labels: MetricLabels): string {
    const labelStr = Object.entries(labels)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  private formatLabels(labels: MetricLabels): string {
    const entries = Object.entries(labels).filter(([, v]) => v !== undefined);
    return entries.length ? ` {${entries.map(([k, v]) => `${k}=${v}`).join(',')}}` : '';
  }
}
