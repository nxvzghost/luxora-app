# 02 — Dedicated Fixtures (arquitetura oficial da Suíte Crítica)

**Status:** Documento oficial. Referência obrigatória para qualquer novo Teste Crítico que precise criar dado real contra Postgres.
**Origem:** "Critical Suite stability — Etapa 1" (histórico do projeto) e AD-034 (`docs/PLANO_DE_EXECUCAO.md`).

## Objetivo

Todo Teste Crítico que precisa de um Tenant/Therapist/Patient real (não mockado) usa um **Tenant totalmente dedicado à própria execução**, nunca o Tenant seedado global ("Clínica Teste A/B") — exceto os testes cujo propósito explícito é validar o isolamento sobre o dado seedado (ver "Exceções legítimas" abaixo). Isso existe para eliminar duas classes de problema já observadas neste projeto:

- **Acúmulo de dado órfão** ao longo de execuções repetidas contra um banco de dev persistente (ex.: 1094 `Appointment`s acumulados no mesmo terapeuta seedado antes da Etapa 1; 70 `Therapist`s órfãos em `audit-immutability.test.ts` antes de um `finally` ad-hoc).
- **Pressão de conexões concorrentes** quando múltiplos arquivos, cada um abrindo pools próprios sem necessidade, rodam em paralelo (`maxWorkers=6`, ver AD-034).

## Onde vive

`apps/backend/test/critical/support/dedicated-fixture.ts` — três funções exportadas:

- `createDedicatedFixture(fixturePrisma, label, options?)` — cria Tenant + Therapist + Patient dedicados (e, opcionalmente, `ClinicSubscription` ativa e/ou `AvailabilityCalendar`), retorna um objeto `DedicatedFixture`.
- `createDedicatedUserAndLogin(fixturePrisma, app, fixture, label)` — cria um `User` real para o Tenant da fixture e retorna um token JWT válido, via login HTTP real.
- `cleanupDedicatedFixture(fixturePrisma, fixture)` — apaga tudo o que a fixture criou, na ordem que respeita as FKs.

## Ciclo de vida esperado

```
beforeAll:
  1. fixturePrisma = new PrismaClient({ ...conexão como superusuário Postgres... })
     await fixturePrisma.$connect()
     — ver "Por que superusuário" abaixo.
  2. fixture = await createDedicatedFixture(fixturePrisma, 'LABEL', { withActiveSubscription?, withAvailabilityCalendar? })
  3. (opcional) await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'LABEL')

execução dos testes:
  — usam fixture.tenantId / fixture.therapistId / fixture.patientId / fixture.token
  — todo recurso NOVO criado durante um teste (Appointment, Session, Billing,
    Payment, Therapist extra) é registrado na coleção correspondente da
    fixture antes do teste terminar (ver seção seguinte)

afterAll:
  await cleanupDedicatedFixture(fixturePrisma, fixture)
  await fixturePrisma.$disconnect()
  await app?.close()  // se o arquivo usa bootstrapTestApp()
```

### Por que superusuário para `fixturePrisma`

`fixturePrisma` é usado exclusivamente para **arrange/cleanup** (criar e apagar a fixture em si) — nunca para a asserção que o teste está validando. Conectar como superusuário do Postgres aqui é intencional: contornar RLS para poder montar/desmontar o cenário livremente, sem que a própria infraestrutura de teste dependa de `app.tenant_id` estar setado. A asserção em si sempre roda pela role real da aplicação (`luxora_app`, sujeita a RLS) — nunca pelo `fixturePrisma`.

## Como registrar múltiplos recursos do mesmo tipo

`DedicatedFixture` expõe **coleções**, não campos individuais por recurso:

```ts
export interface DedicatedFixture {
  tenantId: string;
  therapistId: string;   // terapeuta principal — sempre o primeiro elemento de therapistIds
  patientId: string;
  subscriptionId?: string;
  calendarId?: string;
  clinicSettingsId?: string;
  userId?: string;
  token?: string;
  therapistIds: string[];
  userIds: string[];
  appointmentIds: string[];
  sessionIds: string[];
  billingIds: string[];
  paymentIds: string[];
}
```

Um teste que precisa de um segundo terapeuta (ou segundo appointment, etc.) **nunca** cria uma variável solta (`secondTherapistId`, `extraTherapistId`, `tempTherapist`) — cria o recurso e dá `push()` na coleção correspondente da fixture:

```ts
const extra = await fixturePrisma.therapist.create({ data: { tenantId: fixture.tenantId, ... } });
fixture.therapistIds.push(extra.id);
```

`cleanupDedicatedFixture()` já apaga toda a coleção via `deleteMany({ where: { id: { in: fixture.therapistIds } } })` — nenhuma mudança na função é necessária para suportar N terapeutas.

**Se um teste precisar de um tipo de recurso que a fixture ainda não rastreia** (ex.: `ClinicHoliday`, `RecurringBlock`), a evolução correta é adicionar uma nova coleção (`clinicHolidayIds: string[]` etc.) à interface e ao cleanup — nunca criar limpeza manual paralela no arquivo do teste.

**Exemplo real desta evolução:** `clinicSettingsId?: string` (AD-003) — campo singular, mesmo padrão de `subscriptionId`/`calendarId` (não uma coleção, porque só existe um `ClinicSettings` por Tenant). Ativado via `options.withClinicSettings`; necessário para qualquer teste HTTP de `ClinicController`, que lança `ClinicNotFoundError` sem esta linha existir.

**Outro exemplo real:** `userIds: string[]` (AD-003). `createDedicatedUserAndLogin(fixturePrisma, app, fixture, label, role?)` agora aceita um `role` opcional (`UserRole`, default `admin`) para permitir testar RBAC — um mesmo Tenant dedicado pode ter Users `admin`, `therapist` e `super_admin` simultaneamente, um por chamada. Cada chamada dá `push()` do novo User em `fixture.userIds`; `cleanupDedicatedFixture()` apaga toda a coleção via `deleteMany()`, igual a `therapistIds`. `fixture.userId`/`fixture.token` continuam existindo e sempre apontam para o **último** User criado — mantidos só por compatibilidade com os arquivos que já existiam antes da AD-003 e assumem um único usuário admin por fixture; nenhuma chamada existente com 4 argumentos muda de comportamento.

## Proibição de limpezas manuais duplicadas

Nenhum arquivo de Teste Crítico deve reimplementar sua própria lógica de criação/limpeza de Tenant dedicado. Se um arquivo precisa de um Tenant isolado, usa `createDedicatedFixture()`/`cleanupDedicatedFixture()` — nunca `fixturePrisma.tenant.create()`/`.delete()` direto no arquivo do teste. Motivo: cada reimplementação é uma nova chance de esquecer um recurso no cleanup (foi exatamente essa lacuna, num arquivo com lógica própria, que causou a violação de FK corrigida na AD-034).

## Resiliência

`cleanupDedicatedFixture()` aceita `fixture: DedicatedFixture | undefined` e retorna imediatamente, sem erro, se `fixture` nunca foi inicializada — cobre o caso de um `beforeAll` que falha antes de `createDedicatedFixture()` retornar. Isso existe para que a causa real de uma falha de `beforeAll` apareça no relatório de teste, em vez de ser mascarada por um `TypeError` secundário dentro do `afterAll`.

## Compartilhamento de conexão dentro de um mesmo arquivo

Testes que precisam montar um `PrismaService`/guard fora do app bootstrapado (ex.: testar um Guard diretamente) devem reutilizar **um único** `PrismaClientProvider` compartilhado, criado uma vez no `beforeAll` do arquivo — nunca um `new PrismaClientProvider()` por teste. Isolamento entre testes continua garantido porque:

- `TenantContext` é sempre uma instância nova por teste (`new TenantContext()`), nunca reaproveitada.
- Isolamento de RLS depende de `SET LOCAL` dentro de uma transação (`PrismaService.forTenant()`/`forAuthLookup()`), nunca de qual objeto `PrismaClient` está por baixo.
- Só a infraestrutura de conexão é compartilhada — nenhum estado de aplicação atravessa de um teste para outro.

Ver `tenant-api-key.test.ts` para a implementação de referência.

## Exceções legítimas (não usam Dedicated Fixture, por desenho)

- **`multi-tenant-isolation.test.ts`** — testa o isolamento sobre os Tenants seedados de verdade ("Clínica Teste A/B"), propositalmente. Um Tenant dedicado não provaria a mesma coisa. Não cria dado, `afterAll` só desconecta.
- **`cache-tenant-isolation.test.ts`** — `describe.skip` documentado (não existe camada de cache de aplicação hoje). N/A.
- **Testes puramente de leitura sobre o seed** (`clinic-holiday-persistence.test.ts`, `recurring-block-persistence.test.ts`, `auth-rls-bypass-scope.test.ts`) — fazem `findFirst`/lookup contra "Clínica Teste A/B" para montar o cenário. Ver ressalva na auditoria (seção 2 do fechamento do ciclo) sobre dado criado por estes arquivos nunca ser limpo.

## Documentos relacionados

- `00-Estrategia-de-Testes.md`
- `01-Testes-Criticos.md`
- `03-Database/09-Multi-Tenant.md` (RLS)
- `PLANO_DE_EXECUCAO.md`, Epic 13
