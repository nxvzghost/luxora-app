import { Module } from '@nestjs/common';
import { CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { CONTACT_INTENT_CLASSIFIER } from '@domain-services/ai/contact-intent-classifier';
import { PrismaContactRepository } from '@infrastructure/database/repositories/prisma-contact.repository';
import { AnthropicContactIntentClassifier } from '@infrastructure/ai/anthropic-contact-intent-classifier';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { ConsultarContatoUseCase } from '@use-cases/contact/consultar-contato.use-case';
import { PromoverContatoUseCase } from '@use-cases/contact/promover-contato.use-case';
import { AssociarContatoUseCase } from '@use-cases/contact/associar-contato.use-case';
import { ContactIntentActionRouter } from '@use-cases/contact/contact-intent-action-router';
import { AuditModule } from '../audit/audit.module';
import { PatientsModule } from '../patients/patients.module';

/**
 * ContactModule — ADR-0055 (AD-018). Mesmo padrão de CommunicationModule
 * (repositório(s) + Use Cases do mesmo Bounded Context juntos no mesmo
 * módulo, não separados por camada): Fase 3 registrou só `ContactRepository`;
 * Fase 4 acrescenta `ReconhecerOuCriarContatoUseCase`; Fase 6/7 acrescentam
 * ConsultarContatoUseCase, PromoverContatoUseCase, AssociarContatoUseCase,
 * ContactIntentActionRouter e o classificador real — nunca em AIModule
 * diretamente — para que CommunicationModule (dono de
 * ReceberMensagemWhatsAppUseCase) possa importar só ContactModule sem
 * depender de AIModule, que já importa CommunicationModule (evita import
 * circular).
 *
 * `imports: [AuditModule, PatientsModule]` — ReconhecerOuCriarContatoUseCase/
 * PromoverContatoUseCase/AssociarContatoUseCase injetam AuditService; um
 * provider só resolve o que o PRÓPRIO módulo onde ele é declarado importa
 * (Nest não "achata" o grafo — um módulo consumidor importar ContactModule
 * e AuditModule lado a lado, como AIModule já fazia, não bastava — achado
 * real da Fase 4). Importa os módulos em vez de redeclarar seus providers
 * aqui — mesma disciplina anti-duplicação de ADR-0054/AD-036 (InboxModule).
 * PatientsModule é novo nesta Fase 7: PromoverContatoUseCase precisa de
 * CadastrarPacienteUseCase (existente, inalterado) para o Cenário 1
 * (primeira consulta agendada) — cadastra o Patient, depois promove o
 * Contact, nunca duplicando a lógica de cadastro.
 */
@Module({
  imports: [AuditModule, PatientsModule],
  providers: [
    { provide: CONTACT_REPOSITORY, useClass: PrismaContactRepository },
    { provide: CONTACT_INTENT_CLASSIFIER, useClass: AnthropicContactIntentClassifier },
    PrismaService,
    PrismaClientProvider,
    ReconhecerOuCriarContatoUseCase,
    ConsultarContatoUseCase,
    PromoverContatoUseCase,
    AssociarContatoUseCase,
    ContactIntentActionRouter,
  ],
  exports: [CONTACT_REPOSITORY, ReconhecerOuCriarContatoUseCase, ContactIntentActionRouter],
})
export class ContactModule {}
