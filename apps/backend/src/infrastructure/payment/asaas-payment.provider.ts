import { Injectable } from '@nestjs/common';
import {
  PaymentProvider,
  CreateCustomerInput,
  CreateSubscriptionInput,
  AttachCreditCardInput,
} from '@domain-services/subscription/payment-provider';

/**
 * AsaasPaymentProvider — Módulo 17 (ADR-0037).
 * Fonte: docs.asaas.com — header de autenticação confirmado como
 * `access_token` (não Bearer, não Authorization — Asaas usa um header
 * próprio, diferente do padrão OAuth que os outros providers usam).
 *
 * NÃO TESTADO CONTRA A API REAL — sem rede neste ambiente, mesma categoria
 * de pendência de WhatsAppMessageProvider (M11) e AnthropicAIProvider (M12).
 *
 * O número do cartão passa direto por aqui até a Asaas, na mesma chamada —
 * nunca gravado, nunca logado, nunca persistido em nenhuma tabela da
 * Luxora (Diretriz Oficial: "a Luxora nunca armazenará dados sensíveis de
 * cartões").
 */
const MAX_ERROR_BODY_LENGTH = 500;

/**
 * Fase 2 da auditoria (R5) — remove dado de cartão de um texto antes de ele
 * virar mensagem de erro. O corpo de erro devolvido pela Asaas entra na
 * mensagem da exceção, e LuxoraExceptionFilter grava essa mensagem no log:
 * se a Asaas ecoar o que recebeu, o número e o CCV iriam parar no log.
 * Mascara o valor de campos de código de segurança e qualquer sequência de
 * 13 a 19 dígitos (número de cartão, com ou sem espaços/traços).
 */
export function redactCardData(text: string): string {
  return text
    .replace(/("?(?:ccv|cvv|cvc|securityCode)"?\s*[:=]\s*"?)[^",}\s]+/gi, '$1[omitido]')
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, '[número omitido]');
}

@Injectable()
export class AsaasPaymentProvider implements PaymentProvider {
  private get baseUrl(): string {
    return process.env.ASAAS_BASE_URL ?? 'https://api-sandbox.asaas.com/v3';
  }

  private get apiKey(): string {
    const key = process.env.ASAAS_API_KEY;
    if (!key) throw new Error('ASAAS_API_KEY é obrigatório (.env.example).');
    return key;
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Fase 3 da auditoria — a Asaas exige um User-Agent que identifique
        // a aplicação em contas criadas a partir de 13/06/2024 (doc oficial,
        // "Autenticação"). Sem este header o runtime enviaria só "node".
        'User-Agent': `Luxora-Backend (Node.js; ${process.env.ASAAS_ENV ?? 'sandbox'})`,
        access_token: this.apiKey, // header confirmado na doc oficial — nunca Bearer/Authorization
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      // O corpo da REQUISIÇÃO nunca entra na mensagem; o da RESPOSTA entra
      // só depois de mascarado e truncado (ver redactCardData).
      const errorBody = redactCardData(await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
      throw new Error(`Falha na chamada Asaas ${method} ${path} (${response.status}): ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ asaasCustomerId: string }> {
    const result = await this.request<{ id: string }>('/customers', 'POST', {
      name: input.name,
      email: input.email,
      cpfCnpj: input.cpfCnpj,
    });
    return { asaasCustomerId: result.id };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<{ asaasSubscriptionId: string }> {
    const result = await this.request<{ id: string }>('/subscriptions', 'POST', {
      customer: input.asaasCustomerId,
      billingType: input.billingType,
      value: input.value,
      cycle: input.cycle,
      description: input.description,
      nextDueDate: input.nextDueDate,
    });
    return { asaasSubscriptionId: result.id };
  }

  async attachCreditCard(input: AttachCreditCardInput): Promise<void> {
    await this.request(`/subscriptions/${input.asaasSubscriptionId}/creditCard`, 'PUT', {
      creditCard: {
        holderName: input.holderName,
        number: input.number,
        expiryMonth: input.expiryMonth,
        expiryYear: input.expiryYear,
        ccv: input.ccv,
      },
      creditCardHolderInfo: {
        name: input.holderName,
        email: input.holderEmail,
        cpfCnpj: input.holderCpfCnpj,
      },
      remoteIp: input.remoteIp,
    });
  }

  async cancelSubscription(asaasSubscriptionId: string): Promise<void> {
    await this.request(`/subscriptions/${asaasSubscriptionId}`, 'DELETE');
  }
}
