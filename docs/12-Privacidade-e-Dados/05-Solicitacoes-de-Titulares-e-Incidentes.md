# 05 — Solicitações de titulares e incidentes

> **PENDENTE DE APROVAÇÃO.** Procedimento **provisório**, escrito para o que o sistema permite hoje. Os prazos de resposta e o canal de recebimento dependem de decisão e de avaliação jurídica. Toda operação no banco descrita aqui é manual, feita por pessoa autorizada, nunca durante o piloto sem um pedido real e registrado.

## 1. O que o sistema permite hoje

| Pedido | Pelo painel | Pela API | Só pelo banco |
|---|---|---|---|
| Saber quais dados existem | Parcial: cadastro, agenda e cobranças do paciente | Parcial | Conversas, envios, contatos, auditoria |
| Corrigir nome ou telefone | Sim (`PATCH /patients/:id`, administrador e terapeuta) | Sim | — |
| Exportar | Não | Não | Sim, por consulta manual |
| Excluir ou anonimizar | Não (só inativar ou dar alta) | Não (nenhuma rota `DELETE`) | Sim |
| Desfazer vínculo de número | Sim (A-10, administrador) | Sim | — |
| Parar o atendimento automático para alguém | Inativar ou dar alta bloqueia o atendimento automático (A-11) | Sim | — |

## 2. Procedimento provisório

1. **Receber.** O pedido chega à clínica pelo canal que ela definir [a decidir]. A clínica confirma a identidade de quem pede **fora do WhatsApp automático** (nome de perfil não prova nada, ADR-0063).
2. **Registrar.** Data, quem pediu, o quê, quem atendeu. [Onde registrar: a decidir; o sistema não tem esse registro.]
3. **Localizar.** O administrador da clínica encontra o paciente no painel. Conversas, envios e contatos ligados ao telefone só são localizáveis no banco, por pessoa da Luxora autorizada, filtrando pela clínica e pelo telefone.
4. **Atender.**
   - **Acesso:** relatório montado à mão, sem texto de outras pessoas (número compartilhado por responsável e dependente, ADR-0063).
   - **Correção:** pelo painel.
   - **Exclusão:** hoje não há rotina segura. Antes do piloto, a decisão é entre (a) não aceitar exclusão no piloto e informar isso no termo e no aviso, ou (b) escrever e testar uma rotina de anonimização por paciente e por contato (documento 02, seção 3) antes de abrir o piloto. Apagar linhas à mão no banco quebra a contabilidade e a trilha e não é recomendado.
5. **Backups.** O dado continua nos backups feitos antes da exclusão até eles vencerem. O registro do pedido serve para reaplicar a exclusão se um backup antigo for restaurado.
6. **Responder** a quem pediu, no prazo [a definir].

## 3. Incidentes

O sistema não tem hoje alerta de nada (A-12). Até existir:

1. **Quem percebe** (equipe da clínica ou da Luxora) avisa o responsável técnico da Luxora [contato a definir].
2. **Conter:** revogar acessos (desativar usuário revoga a sessão na hora, ADR-0067), trocar segredos (`JWT_SECRET`, token da Meta da clínica, chave da Anthropic), tirar o webhook do ar se for o caso.
3. **Apurar** com o que existe: auditoria (ações, não leituras), logs (sem dado pessoal), histórico de deploy.
4. **Registrar** o que aconteceu, quais dados, de quais clínicas e titulares.
5. **Comunicar** clínicas, titulares e autoridade conforme o termo e a avaliação jurídica [prazos e critérios a definir].

## 4. Lacunas deste procedimento

- Não há registro de pedidos de titular no sistema.
- Não há exportação nem anonimização por paciente.
- Não há registro de quem leu dados direto no banco.
- Não há alerta nem detecção de acesso indevido.
