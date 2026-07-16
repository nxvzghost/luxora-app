\# 07 - Seeds



\## Objetivo



Este documento define a estratégia de inicialização (Seeding) da camada de persistência da plataforma Luxora.



Seu objetivo é estabelecer quais dados deverão existir automaticamente após a criação de um novo ambiente, garantindo que a aplicação possua todas as informações essenciais para seu funcionamento.



Os Seeds representam dados estruturais e não dados operacionais.



\---



\# Filosofia



Na Luxora, Seeds são utilizados exclusivamente para criar informações fundamentais da plataforma.



Eles não devem conter dados específicos de clientes, pacientes ou operações reais.



Seu objetivo é preparar o ambiente para execução da aplicação.



\---



\# Objetivos



Os Seeds garantem:



\- Ambientes padronizados.

\- Facilidade de desenvolvimento.

\- Rapidez na configuração.

\- Consistência entre ambientes.

\- Redução de configurações manuais.



\---



\# Dados Iniciais



Os seguintes dados poderão ser criados automaticamente.



\## Roles



\- Administrator

\- Manager

\- Therapist

\- Secretary

\- Financial

\- Viewer



\---



\## Permissions



Permissões padrão do sistema.



Exemplos.



\- user:create

\- user:update

\- user:delete

\- patient:create

\- patient:update

\- session:create

\- billing:create

\- payment:create



\---



\## Configurações



Valores padrão da plataforma.



Exemplos.



\- Timezone

\- Idioma

\- Moeda

\- Configuração inicial da clínica

\- Políticas padrão



\---



\## Status



Status utilizados pelo domínio.



Exemplos.



Pacientes



\- Active

\- Inactive



Sessões



\- Scheduled

\- Confirmed

\- InProgress

\- Finished

\- Cancelled



Cobranças



\- Pending

\- Paid

\- Overdue

\- Cancelled



\---



\## Métodos de Pagamento



\- PIX

\- Credit Card

\- Debit Card

\- Cash

\- Bank Transfer



\---



\# Organização



Os Seeds deverão ser divididos por contexto.



```

seeds/



core/



identity/



clinical/



financial/



configuration/

```



\---



\# Regras



Todo Seed deverá:



\- ser idempotente;

\- poder ser executado várias vezes;

\- não gerar duplicidade;

\- ser versionado;

\- possuir documentação.



\---



\# Ambientes



Os Seeds poderão variar conforme o ambiente.



\## Desenvolvimento



Poderá conter usuários de teste e dados fictícios.



\---



\## Homologação



Apenas dados necessários para testes.



\---



\## Produção



Somente dados estruturais.



Nunca dados fictícios.



\---



\# Ferramenta



A Luxora utilizará o mecanismo oficial de Seed do Prisma.



Toda carga inicial deverá ser executada através da ferramenta oficial da plataforma.



\---



\# Escopo



Este documento trata exclusivamente da inicialização do banco de dados.



Não contempla:



\- Migrações;

\- Backup;

\- Restore;

\- Importação de clientes;

\- Dados operacionais.



Esses tópicos possuem documentação própria.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 02 - Tabelas

\- 05 - Constraints

\- 06 - Migrations

\- 08 - Views

\- Backend

\- Infrastructure



\---



\# Observações



Os Seeds representam apenas a configuração inicial da plataforma.



Nenhum dado operacional deverá ser distribuído através dos Seeds.



Toda alteração deverá preservar a compatibilidade entre diferentes versões da plataforma.

