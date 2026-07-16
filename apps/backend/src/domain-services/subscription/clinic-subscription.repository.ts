import { ClinicSubscription } from '@domain/subscription/clinic-subscription.entity';

export interface ClinicSubscriptionRepository {
  findByTenantId(tenantId: string): Promise<ClinicSubscription | null>;
  findByAsaasSubscriptionId(asaasSubscriptionId: string): Promise<ClinicSubscription | null>;
  save(subscription: ClinicSubscription): Promise<void>;
}

export const CLINIC_SUBSCRIPTION_REPOSITORY = Symbol('CLINIC_SUBSCRIPTION_REPOSITORY');
