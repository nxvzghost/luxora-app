\# 06 - Migrations



\## Objetivo



Este documento define a estratégia de versionamento da estrutura do banco de dados da plataforma Luxora.



Seu objetivo é garantir que toda alteração estrutural seja rastreável, reproduzível, segura e reversível, permitindo que diferentes ambientes permaneçam sincronizados durante todo o ciclo de vida da aplicação.



Todas as alterações estruturais do banco deverão ocorrer exclusivamente através de migrations.



\---



\# Filosofia



Na Luxora, o banco de dados evolui de forma incremental.



Nenhuma alteração estrutural poderá ser realizada manualmente em ambientes oficiais.



Toda mudança deverá ser documentada, versionada e revisada antes da execução.



\---



\# Objetivos



A estratégia de migrations busca garantir:



\- Evolução controlada da estrutura.

\- Histórico completo de alterações.

\- Reprodutibilidade entre ambientes.

\- Facilidade de rollback.

\- Segurança durante deploys.

\- Compatibilidade entre versões.



\---



\# Estrutura



As migrations deverão seguir uma sequência cronológica.



Exemplo.



```

migrations/



001\_initial\_schema



002\_create\_patient



003\_create\_session



004\_create\_billing



005\_create\_payment



006\_create\_audit\_log

```



Cada migration representa uma única alteração lógica.



\---



\# Regras



Toda migration deverá:



\- possuir um único objetivo;

\- ser reversível sempre que possível;

\- não alterar múltiplos contextos simultaneamente;

\- ser revisada antes da execução;

\- manter compatibilidade com versões anteriores durante o período de transição.



\---



\# Tipos de Migrations



As migrations podem ser utilizadas para:



\- criação de tabelas;

\- alteração de colunas;

\- criação de índices;

\- criação de constraints;

\- criação de views;

\- criação de funções;

\- atualização de dados estruturais;

\- remoção de estruturas obsoletas.



\---



\# Versionamento



Toda migration deverá possuir identificação única.



Exemplo.



```

001\_initial\_schema



002\_create\_users



003\_create\_patients



004\_create\_sessions



005\_create\_billing

```



A ordem representa a evolução histórica da base.



\---



\# Boas Práticas



\- Nunca editar uma migration já executada.

\- Criar sempre uma nova migration.

\- Testar migrations em ambiente local.

\- Executar validações antes do deploy.

\- Evitar migrations extremamente grandes.

\- Preferir pequenas evoluções incrementais.



\---



\# Rollback



Sempre que tecnicamente possível, cada migration deverá possuir estratégia de rollback.



Quando não houver possibilidade segura de reversão, essa limitação deverá ser documentada.



\---



\# Ambientes



Todas as migrations deverão funcionar igualmente em:



\- Desenvolvimento

\- Homologação

\- Produção



Nenhum ambiente poderá possuir alterações estruturais exclusivas.



\---



\# Ferramenta



A Luxora utilizará o Prisma Migrate como mecanismo oficial de versionamento do banco de dados.



Toda migration deverá ser gerada e aplicada através das ferramentas oficiais do Prisma.



\---



\# Escopo



Este documento trata exclusivamente do versionamento da estrutura do banco.



Não contempla:



\- Seeds;

\- Backup;

\- Restore;

\- Replicação;

\- Deploy;

\- Performance.



Esses assuntos possuem documentação específica.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 01 - Diagrama ER

\- 02 - Tabelas

\- 03 - Relacionamentos

\- 04 - Índices

\- 05 - Constraints

\- 07 - Seeds

\- Backend

\- Infrastructure



\---



\# Observações



As migrations representam a evolução oficial da camada de persistência.



Toda alteração estrutural deverá obrigatoriamente possuir uma migration correspondente.



A consistência entre migrations, schema e documentação deverá ser preservada durante toda a evolução da plataforma.

