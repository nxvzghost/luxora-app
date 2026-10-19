# Entrada da clínica piloto — roteiro

**Origem:** A-16 da auditoria; decisão do responsável pelo produto em 19/10/2026 ([ADR-0066](../02-Arquitetura/ADRs/ADR-0066-correcoes-do-whatsapp-antes-da-homologacao.md)): a clínica piloto entra por **provisionamento manual documentado, sem cobrança de assinatura**.

**Por quê:** nenhuma rota cria clínica, quase toda rota exige assinatura ativa, e o fluxo de assinatura pela Asaas nunca foi validado em produção (e passa número e CVV do cartão pelo backend). O piloto não depende dele.

**Pré-requisitos — nenhum existe hoje:** ambiente de homologação no ar (A-12), com backup e alerta; o número de WhatsApp da clínica com acesso à API da Meta; o aceite da clínica para o piloto (A-14, governança dos dados). Este roteiro não autoriza o piloto: ele só descreve a entrada.

## Passo a passo

1. **Provisionar a clínica.** Com a aplicação implantada, dentro do contêiner do backend:

   ```bash
   node dist/cli/provisionar-clinica-piloto.js --nome "Nome da Clínica" --fuso America/Sao_Paulo
   ```

   Na máquina de desenvolvimento: `pnpm --filter @luxora/backend provision:pilot --nome "Nome da Clínica"`.

   Em uma transação só, o script cria a clínica, as configurações (fuso validado pela base IANA), as configurações de IA, uma **assinatura de cortesia** (ativa, plano `enterprise`, até 5 terapeutas, **sem nenhum vínculo com a Asaas**) e o registro `ClinicaProvisionadaParaPiloto` na auditoria. Nome repetido, fuso inválido ou plano inexistente: recusado, nada é criado. A saída mostra o **id da clínica**; nenhuma senha passa pelo script.

2. **Criar o administrador.** A própria pessoa responsável pela clínica cria o acesso, escolhendo a senha (mínimo de 8 caracteres), pela rota pública que já existe:

   ```bash
   curl -X POST https://<api>/api/v1/users/bootstrap-admin -H 'Content-Type: application/json' \
     -d '{"tenantId":"<id da clínica>","email":"<e-mail>","password":"<senha escolhida por ela>"}'
   ```

   A rota só aceita o primeiro administrador de cada clínica e tem limite de tentativas. Se a pessoa não puder fazer isso, quem conduz a entrada faz junto com ela, sem anotar a senha.

3. **Configurar pelo painel**, com o administrador:
   - Configurações: confirmar o fuso; dados de pagamento (chave PIX e favorecido); políticas de cobrança e de cancelamento.
   - Terapeutas: cadastrar cada um e a agenda de cada um (Disponibilidade).
   - Usuários: criar os acessos da equipe.
   - Pacientes: cadastrar os pacientes do piloto, com o telefone de cada um.
   - Configurações → WhatsApp: conectar o número da clínica.

4. **Conferir antes de abrir para pacientes:** uma mensagem de teste de um número da equipe, a resposta no WhatsApp e a conversa no painel; uma cobrança de teste enviada e o aviso de falha, se houver (Notificações).

## O que não fazer

- Não cobrar assinatura nem cadastrar cartão: a assinatura de cortesia não tem cliente nem assinatura na Asaas, e nenhum webhook de cobrança a altera.
- Não criar a clínica direto no banco: o script mantém a auditoria e a validação do fuso.
- Não reutilizar o nome de outra clínica: o script recusa.

## Desfazer

Antes de qualquer dado real, a clínica pode ser removida com os mesmos passos de limpeza dos testes (auditoria, usuários, assinatura, configurações e a clínica, nessa ordem). Depois de dados reais, não há remoção: a decisão é do responsável pelo produto.
