import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '@use-cases/ai/system-prompt.builder';

describe('buildSystemPrompt', () => {
  it('inclui o princípio fundador de acolhimento', () => {
    const prompt = buildSystemPrompt({ clinicName: 'Clínica X', therapistNames: ['Dra. Ana'] });
    expect(prompt).toContain('vulnerabilidade real');
  });

  it('inclui o critério de autonomia e a instrução de nunca decidir sozinho fora dele', () => {
    const prompt = buildSystemPrompt({ clinicName: 'Clínica X', therapistNames: [] });
    expect(prompt).toContain('requiresEscalation=true');
    expect(prompt).toContain('nunca tente resolver por conta própria');
  });

  it('nunca instrui a mencionar dado clínico', () => {
    const prompt = buildSystemPrompt({ clinicName: 'Clínica X', therapistNames: [] });
    expect(prompt).toContain('Nunca mencione dado clínico');
  });

  it('lista os terapeutas da clínica configurada', () => {
    const prompt = buildSystemPrompt({ clinicName: 'Clínica X', therapistNames: ['Dra. Ana', 'Dr. João'] });
    expect(prompt).toContain('Dra. Ana');
    expect(prompt).toContain('Dr. João');
  });

  it('inclui o nome da clínica', () => {
    const prompt = buildSystemPrompt({ clinicName: 'Clínica Bem-Estar', therapistNames: [] });
    expect(prompt).toContain('Clínica Bem-Estar');
  });
});
