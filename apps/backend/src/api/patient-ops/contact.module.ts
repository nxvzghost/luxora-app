import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PATIENT_REPOSITORY } from '@domain-services/patient-ops/patient.repository';
import { NOTIFICATION_REPOSITORY } from '@domain-services/platform/notification.repository';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { CONTACT_INTENT_CLASSIFIER } from '@domain-services/ai/contact-intent-classifier';
import { PrismaContactRepository } from '@infrastructure/database/repositories/prisma-contact.repository';
import { PrismaPatientRepository } from '@infrastructure/database/repositories/prisma-patient.repository';
import { PrismaNotificationRepository } from '@infrastructure/database/repositories/prisma-notification.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';
import { AnthropicContactIntentClassifier } from '@infrastructure/ai/anthropic-contact-intent-classifier';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaUnitOfWork } from '@infrastructure/database/prisma-unit-of-work';
import { UNIT_OF_WORK } from '@domain-services/platform/unit-of-work';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { ConsultarContatoUseCase } from '@use-cases/contact/consultar-contato.use-case';
import { PromoverContatoUseCase } from '@use-cases/contact/promover-contato.use-case';
import { AssociarContatoUseCase } from '@use-cases/contact/associar-contato.use-case';
import { IdentificarContatoUseCase } from '@use-cases/contact/identificar-contato.use-case';
import { ResolverIdentidadeDoContatoUseCase } from '@use-cases/contact/resolver-identidade-do-contato.use-case';
import { VincularContatoAPacienteUseCase } from '@use-cases/contact/vincular-contato-a-paciente.use-case';
import { ListarContatosPendentesUseCase } from '@use-cases/contact/listar-contatos-pendentes.use-case';
import { SolicitarAtendimentoHumanoUseCase } from '@use-cases/contact/solicitar-atendimento-humano.use-case';
import { ContactIntentActionRouter } from '@use-cases/contact/contact-intent-action-router';
import { ContactsController } from './contacts.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
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
 *
 * ADR-0063 (AD-037 e AD-038) — acrescenta a regra única de identidade
 * (ResolverIdentidadeDoContatoUseCase), a guarda do nome
 * (IdentificarContatoUseCase), o aviso à clínica
 * (SolicitarAtendimentoHumanoUseCase) e a aprovação do vínculo de número
 * novo pelo painel (ContactsController, só administrador). Os repositórios
 * de paciente, de notificação e de assinatura são declarados aqui como nos
 * demais módulos que os usam; AssociarContatoUseCase continua registrado,
 * mas o roteador não o chama mais — nenhuma associação nasce sem a clínica.
 *
 * `UNIT_OF_WORK` — a transação única em que rodam a aprovação do vínculo e
 * toda mudança de estado de um Contact que já existe (identificar, promover,
 * a primeira interação). Fica declarada só aqui: nenhum outro módulo a usa.
 */
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET }), AuditModule, PatientsModule],
  controllers: [ContactsController],
  providers: [
    { provide: CONTACT_REPOSITORY, useClass: PrismaContactRepository },
    { provide: PATIENT_REPOSITORY, useClass: PrismaPatientRepository },
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    { provide: CONTACT_INTENT_CLASSIFIER, useClass: AnthropicContactIntentClassifier },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
    PrismaService,
    PrismaClientProvider,
    ReconhecerOuCriarContatoUseCase,
    ConsultarContatoUseCase,
    PromoverContatoUseCase,
    AssociarContatoUseCase,
    IdentificarContatoUseCase,
    ResolverIdentidadeDoContatoUseCase,
    VincularContatoAPacienteUseCase,
    ListarContatosPendentesUseCase,
    SolicitarAtendimentoHumanoUseCase,
    ContactIntentActionRouter,
    JwtAuthGuard,
    RolesGuard,
    SubscriptionAccessGuard,
  ],
  exports: [
    CONTACT_REPOSITORY,
    ReconhecerOuCriarContatoUseCase,
    ResolverIdentidadeDoContatoUseCase,
    SolicitarAtendimentoHumanoUseCase,
    ContactIntentActionRouter,
  ],
})
export class ContactModule {}
