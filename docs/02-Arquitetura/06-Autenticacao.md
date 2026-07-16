# Autenticação

\# Luxora



\# Architecture Documentation



\## Documento 06 — Autenticação e Autorização



\*\*Versão:\*\* 1.0



\*\*Status:\*\* Oficial



\---



\# Objetivo



Este documento define como usuários serão autenticados, autorizados e identificados dentro da plataforma Luxora.



A autenticação garante a identidade do usuário.



A autorização determina quais recursos esse usuário pode acessar.



Toda requisição protegida deverá obedecer às regras descritas neste documento.



\---



\# Princípios



A segurança da Luxora baseia-se nos seguintes princípios:



\* Menor privilégio.

\* Defesa em profundidade.

\* Zero confiança (Zero Trust).

\* Sessões seguras.

\* Auditoria obrigatória.

\* Isolamento entre clínicas.



Nenhum usuário deverá possuir mais permissões do que o necessário.



\---



\# Conceitos



\## Autenticação



Processo de confirmar quem é o usuário.



Exemplos:



\* E-mail e senha.

\* Login social (futuro).

\* Autenticação multifator (futuro).



\---



\## Autorização



Processo que determina o que um usuário pode fazer.



Exemplos:



\* Visualizar pacientes.

\* Registrar pagamentos.

\* Alterar configurações.

\* Gerenciar usuários.



\---



\## Sessão



Representa um acesso autenticado à plataforma.



Cada sessão possui:



\* usuário;

\* clínica;

\* horário de início;

\* horário de expiração;

\* dispositivo (quando disponível);

\* endereço IP (quando disponível).



\---



\# Perfis de Usuário



A primeira versão da Luxora deverá suportar os seguintes perfis:



\## Administrador da Clínica



Permissões:



\* Configurar a clínica.

\* Gerenciar usuários.

\* Gerenciar terapeutas.

\* Acessar todos os módulos administrativos.

\* Alterar políticas operacionais.



\---



\## Terapeuta



Permissões:



\* Consultar agenda.

\* Consultar pacientes.

\* Registrar atendimentos administrativos.

\* Aprovar exceções.

\* Receber escalonamentos.



Não poderá alterar configurações globais da clínica, salvo autorização específica.



\---



\## Assistente Administrativo (Futuro)



Permissões configuráveis.



Exemplos:



\* Agenda.

\* Financeiro.

\* Cobranças.

\* Follow-up.



\---



\## Super Administrador



Perfil interno da plataforma.



Responsável por:



\* suporte;

\* manutenção;

\* administração da infraestrutura.



Nunca deverá acessar dados de uma clínica sem mecanismos formais de autorização e auditoria.



\---



\# Fluxo de Login



1\. Usuário informa credenciais.

2\. Backend valida identidade.

3\. Verifica se a conta está ativa.

4\. Verifica vínculo com a clínica.

5\. Gera tokens de acesso.

6\. Registra auditoria.

7\. Cria sessão.



\---



\# Tokens



A plataforma utilizará:



\## Access Token



Curta duração.



Utilizado nas requisições autenticadas.



\---



\## Refresh Token



Maior duração.



Responsável por renovar o Access Token sem exigir novo login.



\---



\# Expiração



Sessões deverão possuir tempo máximo configurável.



Ao expirar:



\* Access Token torna-se inválido.

\* Renovação dependerá do Refresh Token.

\* Caso o Refresh Token também expire, novo login será obrigatório.



\---



\# Controle de Permissões



O acesso será baseado em permissões, não apenas em perfis.



Exemplo:



Administrador



\* Criar Clínica

\* Editar Clínica

\* Alterar Políticas

\* Visualizar Dashboard



Terapeuta



\* Consultar Agenda

\* Consultar Pacientes

\* Registrar Pagamento (quando permitido)



Essa abordagem facilita futuras personalizações.



\---



\# Isolamento entre Clínicas



Todo usuário pertence a uma clínica.



Nenhuma requisição poderá acessar dados de outra clínica.



Esse isolamento deverá ocorrer em todas as camadas da aplicação.



\---



\# Auditoria



Toda autenticação deverá registrar:



\* data;

\* hora;

\* usuário;

\* clínica;

\* IP (quando disponível);

\* dispositivo (quando disponível);

\* resultado.



Eventos registrados:



\* Login realizado.

\* Login falhou.

\* Logout.

\* Renovação de token.

\* Alteração de senha.

\* Bloqueio de conta.



\---



\# Recuperação de Senha



Fluxo previsto:



1\. Solicitação.

2\. Geração de token temporário.

3\. Envio por e-mail.

4\. Definição de nova senha.

5\. Revogação das sessões anteriores.

6\. Registro em auditoria.



\---



\# Política de Senhas



A senha deverá possuir requisitos mínimos de segurança definidos pela plataforma.



Exemplos:



\* comprimento mínimo;

\* combinação de caracteres;

\* armazenamento utilizando algoritmo de hash seguro.



Senhas nunca serão armazenadas em texto puro.



\---



\# Revogação de Sessões



A plataforma deverá permitir:



\* encerrar sessão atual;

\* encerrar todas as sessões do usuário;

\* revogar sessões em caso de alteração de senha ou incidente de segurança.



\---



\# Integração com Autenticação Multifator



Prevista para versões futuras.



Fluxo:



1\. Login.

2\. Validação da senha.

3\. Solicitação de segundo fator.

4\. Liberação da sessão.



\---



\# Comunicação Segura



Toda comunicação autenticada deverá utilizar HTTPS.



Tokens nunca deverão ser enviados em parâmetros de URL.



\---



\# Segurança dos Tokens



Os tokens deverão:



\* possuir tempo de expiração;

\* ser assinados;

\* ser verificados em todas as requisições protegidas.



\---



\# Princípios de Implementação



\* Nenhum endpoint protegido aceitará requisições sem autenticação.

\* Toda autorização ocorrerá no Backend.

\* O Frontend nunca decidirá permissões.

\* O Backend validará clínica, perfil e permissões antes de executar qualquer Caso de Uso.



\---



\# Dependências



Este documento depende de:



\* Princípios Arquiteturais

\* Backend

\* Serviços

\* Arquitetura Geral



Servirá como base para:



\* API

\* Infraestrutura

\* Segurança

\* Monitoramento



\---



\# Conclusão



O sistema de autenticação e autorização da Luxora foi projetado para proteger dados administrativos, preservar o isolamento entre clínicas e garantir que cada usuário execute apenas as ações compatíveis com suas permissões.



A autenticação comprova identidade.



A autorização controla acesso.



A auditoria registra todas as ações relevantes.



Esses três pilares formam a base de segurança da plataforma.



