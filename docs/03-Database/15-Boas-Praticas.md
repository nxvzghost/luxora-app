\# 15 - Boas Práticas



\## Objetivo



Este documento estabelece as boas práticas para desenvolvimento, manutenção e evolução da camada de persistência da plataforma Luxora.



Seu objetivo é padronizar decisões de engenharia, garantir consistência entre diferentes desenvolvedores e preservar a qualidade da arquitetura ao longo do ciclo de vida do sistema.



Estas práticas complementam os demais documentos da pasta Database.



\---



\# Filosofia



Na Luxora, simplicidade, consistência e previsibilidade possuem prioridade sobre soluções complexas.



O banco de dados deve representar fielmente o domínio da aplicação e permanecer fácil de compreender, evoluir e manter.



\---



\# Princípios Gerais



Toda alteração na camada Database deve seguir os seguintes princípios.



\- Clareza.

\- Simplicidade.

\- Consistência.

\- Integridade.

\- Escalabilidade.

\- Manutenibilidade.



\---



\# Modelagem



A modelagem deverá seguir as seguintes práticas.



\- Modelar primeiro o domínio.

\- Evitar redundância desnecessária.

\- Normalizar sempre que fizer sentido.

\- Utilizar relacionamentos explícitos.

\- Evitar estruturas genéricas.

\- Evitar tabelas sem propósito definido.



\---



\# Nomeação



Toda estrutura deverá seguir nomenclatura padronizada.



\## Tabelas



\- inglês;

\- singular;

\- nomes descritivos.



Exemplos.



```

patient



session



billing



payment

```



\---



\## Colunas



Utilizar snake\_case.



Exemplos.



```

created\_at



updated\_at



tenant\_id



patient\_id

```



\---



\## Índices



```

idx\_<tabela>\_<campo>

```



\---



\## Constraints



```

pk\_<tabela>



fk\_<origem>\_<destino>



uk\_<tabela>\_<campo>



chk\_<tabela>\_<campo>

```



\---



\# Integridade



Sempre utilizar.



\- Primary Keys.

\- Foreign Keys.

\- Constraints.

\- Índices.

\- Defaults.

\- Validações estruturais.



Nunca confiar apenas na aplicação.



\---



\# Multi-Tenant



Toda tabela pertencente ao domínio deverá possuir.



```

tenant\_id

```



Toda consulta deverá filtrar obrigatoriamente pelo Tenant.



Nenhuma exceção deverá ser implementada sem justificativa arquitetural.



\---



\# Migrations



As migrations deverão.



\- possuir responsabilidade única;

\- ser pequenas;

\- ser revisadas;

\- ser versionadas;

\- possuir rollback sempre que possível.



Nunca editar migrations já executadas.



\---



\# Performance



A equipe deverá.



\- medir antes de otimizar;

\- evitar índices desnecessários;

\- revisar consultas críticas;

\- monitorar planos de execução;

\- evitar otimizações prematuras.



\---



\# Segurança



Nunca armazenar.



\- senhas em texto puro;

\- tokens sensíveis;

\- informações confidenciais sem criptografia.



Toda informação sensível deverá seguir a política de segurança da plataforma.



\---



\# Auditoria



Toda alteração relevante deverá gerar registros de auditoria.



Nenhuma operação crítica deverá ocorrer sem rastreabilidade.



\---



\# Documentação



Toda alteração estrutural deverá atualizar.



\- documentação;

\- diagramas;

\- migrations;

\- schema;

\- ADRs quando necessário.



Código e documentação devem permanecer sincronizados.



\---



\# O que evitar



Evitar.



\- SELECT \*

\- Triggers complexas.

\- Regras de negócio no banco.

\- SQL duplicado.

\- Índices sem necessidade.

\- Campos genéricos.

\- Estruturas não documentadas.

\- Alterações manuais em produção.



\---



\# Checklist



Antes de aprovar qualquer alteração na camada Database verificar.



\- A modelagem representa o domínio?

\- Existe migration?

\- Existe documentação?

\- Existe índice quando necessário?

\- Existe constraint adequada?

\- Respeita Multi-Tenant?

\- Está documentado?

\- Possui impacto conhecido?



\---



\# Escopo



Este documento reúne recomendações gerais para a camada Database.



As regras específicas encontram-se distribuídas pelos demais documentos desta pasta.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 01 - Diagrama ER

\- 02 - Tabelas

\- 03 - Relacionamentos

\- 04 - Índices

\- 05 - Constraints

\- 06 - Migrations

\- 07 - Seeds

\- 08 - Auditoria

\- 09 - Multi-Tenant

\- 10 - Views

\- 11 - Funções e Triggers

\- 12 - Performance

\- 13 - Backup e Restore

\- 14 - Versionamento



\---



\# Observações



As boas práticas definidas neste documento representam o padrão oficial da camada Database da Luxora.



Toda evolução da plataforma deverá preservar estes princípios, garantindo consistência entre arquitetura, implementação e documentação.



Este documento deve ser revisado periodicamente para acompanhar a evolução tecnológica e arquitetural da plataforma.

