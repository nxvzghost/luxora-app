import { describe, it, expect } from 'vitest';
import { MetricsService } from '@shared/metrics.service';

describe('MetricsService — ADR-0055 (AD-018), Fase 8.2', () => {
  describe('incrementCounter()', () => {
    it('começa em zero para um contador nunca incrementado', () => {
      const metrics = new MetricsService();
      expect(metrics.getCounter('nunca_incrementado')).toBe(0);
    });

    it('acumula incrementos sucessivos', () => {
      const metrics = new MetricsService();
      metrics.incrementCounter('chamadas');
      metrics.incrementCounter('chamadas');
      metrics.incrementCounter('chamadas', {}, 3);
      expect(metrics.getCounter('chamadas')).toBe(5);
    });

    it('labels diferentes são contadores independentes', () => {
      const metrics = new MetricsService();
      metrics.incrementCounter('chamadas', { outcome: 'success' });
      metrics.incrementCounter('chamadas', { outcome: 'error' });
      metrics.incrementCounter('chamadas', { outcome: 'success' });

      expect(metrics.getCounter('chamadas', { outcome: 'success' })).toBe(2);
      expect(metrics.getCounter('chamadas', { outcome: 'error' })).toBe(1);
    });

    it('ordem das chaves do label não importa — mesma chave interna', () => {
      const metrics = new MetricsService();
      metrics.incrementCounter('x', { a: '1', b: '2' });
      metrics.incrementCounter('x', { b: '2', a: '1' });
      expect(metrics.getCounter('x', { a: '1', b: '2' })).toBe(2);
    });

    it('labels com valor undefined são ignorados na chave', () => {
      const metrics = new MetricsService();
      metrics.incrementCounter('x', { a: '1', b: undefined });
      expect(metrics.getCounter('x', { a: '1' })).toBe(1);
    });
  });

  describe('observe()', () => {
    it('agrega count/sum/min/max corretamente', () => {
      const metrics = new MetricsService();
      metrics.observe('latencia_ms', 100);
      metrics.observe('latencia_ms', 300);
      metrics.observe('latencia_ms', 50);

      const stats = metrics.getObservationStats('latencia_ms');
      expect(stats).toEqual({ count: 3, sum: 450, min: 50, max: 300 });
    });

    it('nunca existe antes da primeira observação', () => {
      const metrics = new MetricsService();
      expect(metrics.getObservationStats('nunca_observado')).toBeUndefined();
    });

    it('labels diferentes são observações independentes', () => {
      const metrics = new MetricsService();
      metrics.observe('custo_brl', 0.01, { call_type: 'interpretIntent' });
      metrics.observe('custo_brl', 0.02, { call_type: 'generateResponse' });

      expect(metrics.getObservationStats('custo_brl', { call_type: 'interpretIntent' })!.sum).toBeCloseTo(0.01, 5);
      expect(metrics.getObservationStats('custo_brl', { call_type: 'generateResponse' })!.sum).toBeCloseTo(0.02, 5);
    });
  });
});
