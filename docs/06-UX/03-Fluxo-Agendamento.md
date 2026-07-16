# 03 - Fluxo: Agendamento

## Objetivo

Detalhar o fluxo operacional mais frequente da plataforma (RF-051 a RF-060, JP-003), consumindo `04-API/01-Contratos-REST.md` (seção Agenda e Agendamento).

---

# Fluxo principal

```
1. Selecionar Paciente (existente ou novo — JP-001/JP-002)
   ↓
2. Consultar disponibilidade do Terapeuta (GET /therapists/{id}/availability)
   ↓
3. Selecionar horário
   ↓
4. Confirmar modalidade (presencial/online/híbrida) e recorrência, se aplicável
   ↓
5. Salvar (POST /appointments)
   ↓
6. Feedback de sucesso + opção de enviar confirmação imediata ao paciente
```

---

# Tratamento de conflito

Quando `POST /appointments` retorna `SESSION_CONFLICT` (`04-API/00-Principios-da-API.md`), a interface nunca apenas exibe erro genérico — reapresenta a lista de disponibilidade atualizada, com o horário conflitante já removido, permitindo nova escolha sem reiniciar o fluxo (RF-044, RF-045 — sugerir encaixes).

---

# Agendamento recorrente

Quando o Paciente possui frequência definida (semanal/quinzenal/mensal — RF-033), a interface oferece a opção "repetir este agendamento" durante a etapa 4, delegando ao Backend (`POST /appointments/recurring`) o ajuste automático para feriados/férias/bloqueios (JP-010), sem que o Frontend precise calcular datas.

---

# Confirmação e lembretes

A etapa 6 não substitui a automação de lembretes já prevista via n8n (ADR-0021) — é uma ação manual opcional para o caso em que o profissional queira confirmar imediatamente, além do fluxo automático que ocorrerá conforme a antecedência configurada em `06-UX/01-Fluxo-Configuracao-Clinica.md`.

---

# Documentos Relacionados

- 04-API/01-Contratos-REST.md (Agenda e Agendamento)
- 01-Domain/03-Maquina-de-Estados.md
- 02-Arquitetura/ADRs/ADR-0021.md
