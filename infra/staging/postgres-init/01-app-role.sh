# Luxora — role de runtime da aplicação (homologação).
#
# Mesmo papel de infra/docker/postgres-init/01-app-role.sql (leia lá o porquê:
# o Postgres ignora a Row-Level Security para superusuário), com uma
# diferença: a senha vem do ambiente (POSTGRES_APP_PASSWORD), nunca de um
# valor fixo no repositório.
#
# Executado pela imagem oficial do Postgres só na PRIMEIRA inicialização do
# volume. Num Postgres gerenciado, o administrador cria a role uma vez, com
# os mesmos comandos.
#
# A imagem pode executar este arquivo ou incluí-lo no próprio shell (quando
# vem sem permissão de execução): por isso não há `set -e` nem `exit` aqui.
psql -v ON_ERROR_STOP=1 -v app_password="$POSTGRES_APP_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE luxora_app LOGIN PASSWORD :'app_password';
GRANT ALL ON SCHEMA public TO luxora_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO luxora_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO luxora_app;
-- As migrations rodam com o usuário admin: tudo o que ele criar daqui em
-- diante já nasce acessível à role de runtime.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO luxora_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO luxora_app;
SQL
