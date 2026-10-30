# Luxora — role de backup do banco (homologação). Somente leitura.
#
# Cria (ou acerta) a role luxora_backup, usada SÓ pelo pg_dump do backup externo
# (infra/scripts/external-backup.sh push), que roda no host, com um usuário Linux
# próprio, conectado por 127.0.0.1 (a porta do loopback do compose). Assim o backup
# não precisa de superusuário nem de acesso ao Docker.
#
# Privilégios, e só estes:
#   LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, CONNECTION LIMIT 3
#   pg_read_all_data   SELECT em todas as tabelas, views e sequências (inclusive as
#                      futuras) e USAGE em todos os schemas. Não concede escrita.
#   BYPASSRLS          o pg_dump não aceita a Row-Level Security filtrando linhas: sem
#                      este atributo o dump falharia (ou ficaria incompleto) nas tabelas
#                      com RLS forçada. ATENÇÃO: com ele a role lê TODAS as linhas de
#                      TODAS as clínicas. Isso é o que um backup integral exige; não
#                      concede escrita nem contorna GRANT/REVOKE.
#   default_transaction_read_only = on   trava contra acidente. NÃO é a fronteira de
#                      segurança (a própria sessão pode desligá-la); a fronteira é a
#                      ausência de qualquer privilégio de escrita.
#
# Entrada: POSTGRES_BACKUP_PASSWORD (variável de ambiente do contêiner). Vazia = não faz
# nada. Fraca (menos de 16 caracteres) ou o valor de modelo = não faz nada e avisa.
# A senha NUNCA vai em argumento de processo nem no texto do script: o psql a lê do
# ambiente (\getenv) e a entrega ao servidor como literal citado; o servidor guarda só o
# hash SCRAM, e o registro de erros do servidor é impedido de copiar o comando.
#
# Idempotente: se a role existe, atualiza atributos e senha; remove qualquer
# participação em outras roles além de pg_read_all_data; zera e refaz as configurações
# da role, as globais e as específicas de cada banco (pg_db_role_setting). Não toca na
# role luxora_app nem em nenhum dado do banco.
#
# OBJETOS GRANDES (Large Objects) NÃO SÃO SUPORTADOS nesta versão. O Luxora não os usa, e
# pg_read_all_data não dá a leitura que o pg_dump faz (lo_open): um único objeto grande sem
# ACL de leitura para esta role derruba o pg_dump no meio do arquivo. Portanto:
#   - se pg_largeobject_metadata tiver QUALQUER linha, o script aborta ANTES de criar ou
#     alterar qualquer coisa (não concede SELECT, não muda dono nem conteúdo);
#   - a execução das funções que CRIAM objetos grandes (lo_create, lo_creat, lo_from_bytea,
#     lo_import) é revogada de PUBLIC e desta role, neste banco, para que ela não os crie
#     (o superusuário continua podendo). As funções de leitura/escrita de objetos existentes
#     não são tocadas: já exigem ACL ou dono.
#   - não se usa lo_compat_privileges nem pg_dump --no-large-objects (omitiria dados em silêncio).
# Suportar objetos grandes no futuro exigirá uma implementação própria (ACL e inventário).
#
# QUANDO RODA: a imagem oficial do Postgres executa este arquivo só na PRIMEIRA
# inicialização do volume. Num volume que já existe, nada acontece sozinho: depois de
# acrescentar POSTGRES_BACKUP_PASSWORD ao arquivo de ambiente e recriar o contêiner
# (para ele receber a variável), rode à mão:
#   docker compose ... exec -T postgres bash /docker-entrypoint-initdb.d/02-backup-role.sh
#
# Como o 01-app-role.sh, a imagem pode executar este arquivo ou incluí-lo no próprio
# shell (quando vem sem permissão de execução): por isso não há `set -e` nem `exit`,
# e tudo fica dentro de uma função. O status de saída é o do psql, como no 01.

luxora_backup_role_init() {
  if [ -z "${POSTGRES_BACKUP_PASSWORD:-}" ]; then
    echo "02-backup-role: POSTGRES_BACKUP_PASSWORD vazia — a role luxora_backup NAO foi criada nem alterada."
    return 0
  fi
  if [ "${#POSTGRES_BACKUP_PASSWORD}" -lt 16 ] || [ "$POSTGRES_BACKUP_PASSWORD" = "troque-este-valor" ]; then
    echo "02-backup-role: POSTGRES_BACKUP_PASSWORD fraca ou de modelo (minimo de 16 caracteres) — a role luxora_backup NAO foi criada nem alterada." >&2
    return 0
  fi

  psql -v ON_ERROR_STOP=1 -X --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-postgres}" <<'SQL'
-- Verbosidade mínima ANTES de qualquer comando com a senha: com a padrão, um erro de SQL faz o
-- psql imprimir o trecho do comando (com a senha) na saída de erro, que vai para os logs do contêiner.
\set VERBOSITY terse
-- Nada que contenha a senha pode ir para o registro do servidor.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET password_encryption = 'scram-sha-256';

-- Objetos grandes não são suportados: se existir qualquer um, para sem criar nem alterar nada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_largeobject_metadata) THEN
    RAISE EXCEPTION '02-backup-role: o banco contem objetos grandes (Large Objects), que o backup nao suporta nesta versao. Nada foi criado nem alterado. Remova-os ou implemente o suporte antes de configurar luxora_backup.';
  END IF;
END
$$;

\getenv backup_pw POSTGRES_BACKUP_PASSWORD

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxora_backup') AS role_exists \gset
\if :role_exists
  ALTER ROLE luxora_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 3 PASSWORD :'backup_pw';
\else
  CREATE ROLE luxora_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 3 PASSWORD :'backup_pw';
\endif
\unset backup_pw

-- Participações: só pg_read_all_data. Qualquer outra (de uma execução antiga ou à mão) sai.
SELECT format('REVOKE %I FROM luxora_backup', r.rolname)
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  JOIN pg_roles u ON u.oid = m.member
 WHERE u.rolname = 'luxora_backup' AND r.rolname <> 'pg_read_all_data' \gexec
GRANT pg_read_all_data TO luxora_backup;

-- Funções que criam objetos grandes: ninguém (além do superusuário) as executa neste banco.
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid), pg_catalog.lo_creat(integer),
  pg_catalog.lo_from_bytea(oid, bytea), pg_catalog.lo_import(text), pg_catalog.lo_import(text, oid)
  FROM PUBLIC, luxora_backup;

-- Configurações da role: zera e refaz, para o resultado não depender do histórico.
-- As específicas de cada banco primeiro (RESET ALL sozinho só limpa as globais).
SELECT format('ALTER ROLE luxora_backup IN DATABASE %I RESET ALL', d.datname)
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole
  JOIN pg_database d ON d.oid = s.setdatabase
 WHERE r.rolname = 'luxora_backup' \gexec
ALTER ROLE luxora_backup RESET ALL;
ALTER ROLE luxora_backup SET default_transaction_read_only = on;
SQL
}

luxora_backup_role_init
