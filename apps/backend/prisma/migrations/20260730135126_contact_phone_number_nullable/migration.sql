-- ADR-0055 (AD-018) — ACHADO REAL, corrigido antes da implementação do
-- repositório: Contact.anonimizar() (expurgo LGPD, capacidade de domínio
-- desta AD, sem scheduler) precisa limpar phoneNumber para nulo, mas a
-- migration original desta AD (20260730124223) deixou a coluna NOT NULL —
-- inconsistente com o domínio, que sempre permitiu phoneNumber nulo
-- pós-anonimização. Migration puramente aditiva: só relaxa a constraint,
-- nenhum dado, índice, FK, RLS ou policy é tocado.
ALTER TABLE "contact" ALTER COLUMN "phone_number" DROP NOT NULL;
