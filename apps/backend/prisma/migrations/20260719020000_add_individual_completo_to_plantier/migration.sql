-- PD-003 (Modelo Comercial) / CEO-DEC-002.1 / CEO-DEC-002.6 — Priority 5.
--
-- Adiciona 'individual' e 'completo' ao enum PlanTier — estrutura apenas.
-- Nenhum preço, benefício ou comportamento comercial é definido nesta
-- migration (CEO-DEC-002.3 reserva isso ao Catálogo Comercial Oficial).
--
-- 'professional', 'business' e 'enterprise' permanecem intocados e
-- totalmente funcionais — CEO-DEC-002.6 exige que continuem suportados
-- para clientes já contratados sob o catálogo antigo. Nenhuma linha
-- existente de clinic_subscription é afetada.
--
-- Nota: PostgreSQL não permite ALTER TYPE ... ADD VALUE dentro da mesma
-- transação em que o novo valor é usado — mas como nenhuma linha desta
-- migration usa os novos valores, isso não é uma restrição aqui.

-- AlterEnum
ALTER TYPE "PlanTier" ADD VALUE 'individual';
ALTER TYPE "PlanTier" ADD VALUE 'completo';
