-- Luxora — role de aplicação sem privilégio de superusuário.
--
-- POR QUE ISTO EXISTE (bug real encontrado ao rodar contra Postgres pela
-- primeira vez): o Postgres ignora TODA policy de Row-Level Security para
-- superusuários, incondicionalmente — nem `ALTER TABLE ... FORCE ROW LEVEL
-- SECURITY` (ver apps/backend/prisma/rls/enable-rls.sql) muda isso, FORCE
-- só afeta o dono da tabela quando ele NÃO é superusuário. O usuário
-- `postgres` do container oficial é superusuário por padrão — se a
-- aplicação conectasse com ele, TODA policy de isolamento multi-tenant
-- seria silenciosamente ignorada, mesmo com as policies corretamente
-- criadas. Os Repositories deste projeto dependem 100% de RLS para
-- filtrar por tenant (nenhum WHERE tenant_id explícito nas queries — ver
-- prisma-patient.repository.ts e os demais) — sem esta role, qualquer
-- clínica autenticada enxergaria dados de qualquer outra.
--
-- `luxora_app` não é superusuário e não tem BYPASSRLS — FORCE ROW LEVEL
-- SECURITY passa a valer de verdade para ela, mesmo sendo dona dos objetos
-- que ela mesma cria (inclusive rodando `prisma migrate`).
--
-- Executado automaticamente pela imagem oficial do Postgres na PRIMEIRA
-- inicialização do container (docker-entrypoint-initdb.d) — não roda de
-- novo em containers já inicializados; nesse caso, aplique manualmente.
CREATE ROLE luxora_app LOGIN PASSWORD 'luxora_app_dev_pw';
GRANT ALL ON SCHEMA public TO luxora_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO luxora_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO luxora_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO luxora_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO luxora_app;
