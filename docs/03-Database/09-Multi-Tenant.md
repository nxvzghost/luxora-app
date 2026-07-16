\# 09 - Multi-Tenant



\## Objetivo



Este documento define a estratégia Multi-Tenant utilizada pela camada de persistência da plataforma Luxora.



Seu objetivo é garantir que todos os dados da aplicação permaneçam completamente isolados entre diferentes clínicas, preservando segurança, privacidade e escalabilidade.



Toda entidade persistida deverá respeitar obrigatoriamente os princípios definidos neste documento.



\---



\# Filosofia



Na Luxora, uma Clínica representa um Tenant.



Todo dado armazenado pertence exatamente a um Tenant.



O isolamento entre clínicas é um princípio arquitetural da plataforma e não uma funcionalidade opcional.



\---



\# Modelo de Isolamento



A plataforma adota o modelo:



\*\*Shared Database + Shared Schema + Tenant Isolation\*\*



Cada registro contém obrigatoriamente uma referência ao Tenant proprietário.



```text

Tenant A

&#x20;   │

&#x20;   ├── Patients

&#x20;   ├── Sessions

&#x20;   ├── Billing

&#x20;   └── Payments



Tenant B

&#x20;   │

&#x20;   ├── Patients

&#x20;   ├── Sessions

&#x20;   ├── Billing

&#x20;   └── Payments

```



Os dados coexistem na mesma base física, porém permanecem logicamente isolados.



\---



\# tenant\_id



Toda tabela pertencente ao domínio deverá possuir obrigatoriamente.



```text

tenant\_id UUID NOT NULL

```



Exemplos.



```

patient



session



billing



payment



therapist



user



audit\_log

```



\---



\# Regras



Toda consulta deverá considerar obrigatoriamente o Tenant ativo.



Exemplo.



```sql

SELECT \*



FROM patient



WHERE tenant\_id = :tenantId;

```



Nenhuma operação poderá ignorar esse filtro.



\---



\# Integridade



Toda Foreign Key deverá respeitar o mesmo Tenant.



Não será permitido relacionar registros pertencentes a clínicas diferentes.



Exemplo.



```

patient.tenant\_id



==



session.tenant\_id

```



\---



\# Segurança



O Backend será responsável por garantir que o Tenant autenticado seja aplicado automaticamente em todas as operações.



O banco de dados nunca deverá confiar em informações fornecidas diretamente pelo cliente.



\## Row-Level Security (RLS) como defesa em profundidade



O filtro de `tenant_id` aplicado pela aplicação (Repository) é a primeira camada de isolamento, mas não é a única.



Toda tabela pertencente ao domínio multi-tenant deverá possuir também uma **política de Row-Level Security nativa do PostgreSQL**, garantindo que, mesmo diante de um erro de implementação (uma query sem o filtro de tenant, por exemplo), o próprio banco de dados impeça o acesso a registros de outro Tenant.



### Funcionamento



No início de cada transação, o Backend deverá definir o Tenant ativo na sessão do banco de dados:



```sql

SET app.tenant_id = ':tenantId';

```



Toda tabela multi-tenant deverá possuir uma policy equivalente a:



```sql

ALTER TABLE patient ENABLE ROW LEVEL SECURITY;



CREATE POLICY tenant_isolation ON patient

    USING (tenant_id = current_setting('app.tenant_id')::uuid);

```



### Regras



\- RLS é obrigatório em toda tabela que possua `tenant_id`.

\- O filtro de aplicação (Repository) **não é substituído** pelo RLS — ambas as camadas coexistem.

\- Nenhuma conexão de aplicação deverá utilizar um usuário de banco com privilégio de `BYPASSRLS`, exceto rotinas administrativas de migração, executadas fora do fluxo de requisição normal.

\- A ausência de `app.tenant_id` na sessão deverá resultar em zero linhas retornadas, nunca em erro que exponha estrutura do banco.

\- **Exceção única e documentada:** a tabela `user` possui uma segunda política de SELECT (`auth_lookup_by_email`), ativada apenas quando a aplicação define explicitamente `app.bypass_tenant_check = 'true'` dentro de uma transação — usada exclusivamente pelo fluxo de login (`PrismaService.forAuthLookup()`), nunca por padrão. Ver ADR-0024 (e-mail de usuário globalmente único) e Teste Crítico #17.



### Justificativa



Em um domínio que lida com dados de pacientes de saúde mental, mesmo que apenas administrativos, um vazamento de dados entre clínicas por falha de aplicação é um risco reputacional e legal desproporcional ao custo de implementar RLS desde o schema inicial. Essa camada adicional deve ser tratada como obrigatória desde a primeira migration, nunca como melhoria futura.



\---



\# Índices



Toda tabela Multi-Tenant deverá possuir índice para.



```

tenant\_id

```



Sempre que necessário utilizar índices compostos iniciando por.



```

tenant\_id

```



Exemplos.



```

tenant\_id + status



tenant\_id + patient\_id



tenant\_id + therapist\_id



tenant\_id + scheduled\_at

```



\---



\# Benefícios



Esta estratégia proporciona.



\- Segurança.

\- Escalabilidade.

\- Simplicidade operacional.

\- Facilidade de manutenção.

\- Menor custo de infraestrutura.

\- Evolução incremental.



\---



\# Escopo



Este documento trata exclusivamente da estratégia de isolamento de dados.



Não contempla.



\- Autenticação.

\- Permissões.

\- Infraestrutura.

\- Deploy.

\- API.

\- Backend.



Esses assuntos possuem documentação específica.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 01 - Diagrama ER

\- 02 - Tabelas

\- 03 - Relacionamentos

\- 04 - Índices

\- 05 - Constraints

\- 06 - Migrations

\- Security

\- Backend

\- Infrastructure



\---



\# Observações



O isolamento entre Tenants representa um dos pilares fundamentais da arquitetura da Luxora.



Nenhuma nova tabela deverá ser criada sem avaliar sua relação com o Tenant.



Toda evolução da plataforma deverá preservar esse princípio arquitetural.

