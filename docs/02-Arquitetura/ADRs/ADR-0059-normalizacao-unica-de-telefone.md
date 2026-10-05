# ADR-0059 — Normalização única de telefone na comparação: paciente, conversa e remetente do WhatsApp

**Status:** ADOTADO
**Origem:** Fase 3B da auditoria técnica de 04/10/2026 (preparação para os testes externos).
**Data:** 5 de outubro de 2026

## Objetivo

Fazer um paciente já cadastrado ser reconhecido quando escreve pelo WhatsApp, qualquer que seja a grafia do telefone no cadastro, sem reescrever nenhum dado gravado.

## Auditoria prévia (achados confirmados)

- **A busca era por igualdade exata do texto.** `PatientRepository.findByPhone()` fazia `where: { phone }`. `patient.phone` é texto livre (a API aceita qualquer texto com 8 caracteres ou mais), o cadastro feito pelo próprio sistema grava `+55…` (`PromoverContatoUseCase`) e a Meta entrega o remetente só em dígitos, com o código do país e sem "+". O paciente gravado como `+5541…` não era encontrado pelo remetente `5541…`. Fixado em teste na Fase 3 e invertido nesta.
- **A conversa tinha o mesmo problema.** `ConversationRepository.findByTenantAndPhone()` buscava pelo texto exato; um registro gravado como `+55…` e o mesmo número chegando em dígitos abririam duas conversas.
- **`Contact` já estava certo.** Usa o Value Object `PhoneNumber` (ADR-0055), que normaliza para E.164, só Brasil.
- **O Value Object recusava o DDD 55.** A regra decidia pela presença do "55" inicial se o código do país já estava no número. Um telefone do interior do RS escrito sem o código do país (`(55) 99999-8888`) era lido como "já tem o código do país" e recusado por ter dígitos de menos.
- **Remetente de outro país derrubava o webhook.** A normalização do Contact lançava, a resposta era 500 e a Meta reenviaria o mesmo POST por dias — junto com as mensagens das outras pessoas que vinham nele.

## Decisão

**Uma regra, um lugar.** `PhoneNumber` (`src/domain/contact/phone-number.value-object.ts`) é a única regra de normalização e passa a ser usada também para **comparar** telefones fora do Contact. Continua restrita ao Brasil.

**Forma canônica:** `+55` + DDD + número (8 ou 9 dígitos).

| Entrada | Leitura |
|---|---|
| `+55 41 99999-8888`, `+5541999998888` | Já tem o código do país |
| `5541999998888` (12 ou 13 dígitos) | Já tem o código do país |
| `(41) 99999-8888`, `41 99999 8888`, `41999998888` (10 ou 11 dígitos) | DDD + número; o 55 é acrescentado |
| `(55) 99999-8888`, `55999998888` | DDD 55 + número; o 55 é acrescentado |
| `+51 987 654 321`, `351912345678`, `041 99999-8888`, `99999-8888` | Não é um telefone do Brasil reconhecível: inválido |

Espaços, parênteses, hífens e pontos são ignorados. Quem decide se o código do país já está presente é o "+" inicial ou, sem ele, o tamanho — nunca o "55" no começo.

**Duas leituras, conforme a origem.**

- `PhoneNumber.normalize()` / `tryNormalize()`: para texto digitado por uma pessoa, que pode vir sem o código do país.
- `PhoneNumber.tryFromInternational()`: para o remetente que a Meta entrega, que **sempre** vem com o código do país. Não acrescenta nada: o que não começa por 55 é de outro país. Sem essa distinção, um celular do Peru (`51 9XXXXXXXX`) seria lido como um celular de Porto Alegre escrito sem o 55.

**Onde a comparação mudou.**

- **Paciente** (`PrismaPatientRepository.findByPhone`): o número procurado é normalizado e o valor gravado é comparado só pelos dígitos, contra as duas formas — com o código do país e sem ele. Um valor gravado que começa com "+" só é comparado com a forma com código do país. A consulta roda dentro de `forTenant()`, sob RLS. Havendo mais de um paciente com o mesmo telefone, devolve o cadastro mais antigo.
- **Conversa** (`PrismaConversationRepository.findByTenantAndPhone`): aceita as grafias do mesmo número (a recebida, a E.164 e a de só dígitos) e devolve a conversa mais antiga.
- **Webhook** (`ReceberMensagemWhatsAppUseCase`): remetente que não é do Brasil é confirmado com 200 e ignorado, com aviso em log; as demais mensagens do mesmo POST são processadas.

**Nada gravado é alterado.** `patient.phone` continua como foi digitado e `conversation.phone_number` como chegou. A API de pacientes não mudou.

## Dados existentes e migration

**Não é necessária migration para o reconhecimento funcionar**, e nenhuma foi executada. A comparação normaliza no momento da busca.

O que uma migration traria, se decidida depois:

1. Coluna `patient.phone_normalized` (nula quando o telefone gravado não é normalizável), preenchida pela mesma regra do `PhoneNumber`.
2. Índice em `(tenant_id, phone_normalized)`. Hoje a busca percorre os pacientes da clínica — sem custo perceptível na escala atual, e só na primeira mensagem de um número novo.
3. Relatório dos telefones que não puderam ser normalizados, para correção manual pela clínica.
4. Opcionalmente, validação na API de pacientes, recusando telefone não normalizável — muda o contrato da API e a tela de cadastro.

Nenhum registro seria reescrito: o texto original de `phone` permanece.

## Limitações conhecidas (documentadas, não corrigidas)

- **Nono dígito.** Continua valendo o limite aceito na ADR-0055: um número sem o nono dígito não é igual ao mesmo número com ele. O WhatsApp pode entregar o remetente de contas antigas sem o nono dígito; nesse caso o paciente cadastrado com 9 dígitos não é reconhecido. A confirmar na primeira entrada real pela Meta. Comparar também essa variante é possível sem alterar dado gravado, mas revê uma decisão da ADR-0055.
- **Cadastro duplicado pelo fluxo de identificação.** Reconhecer o paciente pelo telefone não impede que o fluxo de promoção do Contact cadastre um paciente novo: `ContactIntentActionRouter` só usa o paciente já conhecido na decisão `ASSOCIAR`, não na `PROMOVER`. É a lacuna do "Cenário 13" já registrada na ADR-0055 (vincular o Contact a um paciente existente).
- **Telefone do destinatário no envio.** Lembretes e resumos usam o telefone do paciente e do terapeuta como estão gravados. Sem o código do país, a Meta pode recusar o envio ou ler os primeiros dígitos como código de outro país.
- **Alteração de telefone do paciente não é gravada.** `PrismaPatientRepository.save()` não inclui `phone` na atualização. Encontrado nesta auditoria; fora do escopo.
- **Só Brasil.** Remetentes de outros países são ignorados.

## Evidências

- `test/unit/domain/contact/phone-number.value-object.test.ts` — cada grafia aceita, o DDD 55, o "+" de outro país, as duas leituras.
- `test/integration/database/prisma-patient-phone-lookup.repository.test.ts` — 14 testes contra Postgres real, sob RLS: seis grafias gravadas, a grafia do número procurado, telefone fixo, DDD 55, número de outro país, isolamento entre clínicas, cadastro mais antigo.
- `test/critical/whatsapp-webhook.test.ts` — pelo webhook, com o corpo no formato da Meta: paciente reconhecido em quatro grafias, paciente de outra clínica não reconhecido, uma só conversa para duas grafias, remetente de outro país ignorado sem interromper o POST (antes: 500).
- `test/unit/use-cases/communication/receber-mensagem-whatsapp.use-case.test.ts` — remetentes de outros países.
