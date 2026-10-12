import { describe, it, expect, vi } from 'vitest';
import {
  REDACTED,
  redactQueryString,
  redactUrl,
  redactUrlAttributes,
  serializeRedisCommand,
} from '@shared/observability/trace-redaction';

/**
 * Tarefa 07 da auditoria (Fase 1) — o que não pode sair em um trace.
 *
 * Aqui só as regras, como funções puras. O que as instrumentações de verdade
 * exportam está em trace-export.test.ts (HTTP) e em
 * test/critical/trace-no-secrets.test.ts (o app inteiro e a fila).
 */
const TOKEN = 'token-de-verificacao-que-nao-pode-vazar';

describe('redactQueryString', () => {
  it('handshake da Meta: ficam os nomes e o modo; o token e o desafio saem', () => {
    expect(redactQueryString(`hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=1158201444`)).toBe(
      `hub.mode=subscribe&hub.verify_token=${REDACTED}&hub.challenge=${REDACTED}`,
    );
  });

  it('paginação, datas e filtro de estado continuam legíveis', () => {
    const query = 'limit=20&from=2026-10-01T03%3A00%3A00.000Z&to=2026-10-31&state=Ativo';
    expect(redactQueryString(query)).toBe(query);
  });

  it('identificadores e cursor saem sem o valor', () => {
    expect(redactQueryString('patientId=3f0c&therapistId=9a1b&cursor=eyJpZCI6IjEifQ&limit=5')).toBe(
      `patientId=${REDACTED}&therapistId=${REDACTED}&cursor=${REDACTED}&limit=5`,
    );
  });

  it('parâmetro desconhecido nasce redigido — ninguém precisa lembrar de incluí-lo', () => {
    expect(redactQueryString(`access_token=${TOKEN}&novo=valor`)).toBe(`access_token=${REDACTED}&novo=${REDACTED}`);
  });

  it('o nome é comparado depois de decodificado, e o texto original do par é o que fica', () => {
    expect(redactQueryString('hub%2Emode=subscribe')).toBe('hub%2Emode=subscribe');
    expect(redactQueryString(`hub%2Everify_token=${TOKEN}`)).toBe(`hub%2Everify_token=${REDACTED}`);
  });

  it('sem "=" não há como separar nome de valor: sai tudo', () => {
    expect(redactQueryString(TOKEN)).toBe(REDACTED);
    expect(redactQueryString(`limit=5&${TOKEN}`)).toBe(`limit=5&${REDACTED}`);
  });

  it('valor comprido demais em parâmetro "seguro" e nome comprido demais também saem', () => {
    expect(redactQueryString(`state=${'x'.repeat(65)}`)).toBe(`state=${REDACTED}`);
    expect(redactQueryString(`${'n'.repeat(65)}=1`)).toBe(REDACTED);
  });

  it('valor com "=" dentro sai inteiro; par vazio e query vazia não quebram', () => {
    expect(redactQueryString(`token=a=b=${TOKEN}`)).toBe(`token=${REDACTED}`);
    expect(redactQueryString('limit=5&&to=2026-01-01')).toBe('limit=5&&to=2026-01-01');
    expect(redactQueryString('')).toBe('');
  });

  it('codificação inválida no nome não derruba nada', () => {
    expect(redactQueryString('%E0%A4%A=1')).toBe(`%E0%A4%A=${REDACTED}`);
  });

  it('redigir de novo o que já foi redigido não muda nada', () => {
    const once = redactQueryString(`hub.mode=subscribe&hub.verify_token=${TOKEN}`);
    expect(redactQueryString(once)).toBe(once);
  });
});

describe('redactUrl', () => {
  it('endereço completo: só a query muda', () => {
    expect(redactUrl(`https://api.exemplo.com/api/v1/webhooks/whatsapp?hub.verify_token=${TOKEN}&hub.mode=subscribe`)).toBe(
      `https://api.exemplo.com/api/v1/webhooks/whatsapp?hub.verify_token=${REDACTED}&hub.mode=subscribe`,
    );
  });

  it('só caminho e query (o formato de `http.target`)', () => {
    expect(redactUrl(`/api/v1/patients?limit=5&cursor=${TOKEN}`)).toBe(`/api/v1/patients?limit=5&cursor=${REDACTED}`);
  });

  it('sem query, fica como está', () => {
    expect(redactUrl('https://graph.facebook.com/v21.0/123/messages')).toBe('https://graph.facebook.com/v21.0/123/messages');
  });

  it('o conteúdo do fragmento sai, com ou sem query', () => {
    expect(redactUrl(`/retorno?state=ok#access_token=${TOKEN}`)).toBe(`/retorno?state=ok#${REDACTED}`);
    expect(redactUrl(`/retorno#${TOKEN}`)).toBe(`/retorno#${REDACTED}`);
  });
});

describe('redactUrlAttributes', () => {
  function spanWith(attributes: Record<string, unknown>) {
    return {
      attributes,
      setAttribute: vi.fn((key: string, value: string) => {
        attributes[key] = value;
      }),
    };
  }

  it('regrava os quatro atributos que levam a query, nas convenções atuais e nas antigas', () => {
    const span = spanWith({
      'url.query': `hub.verify_token=${TOKEN}`,
      'url.full': `http://localhost:3000/x?hub.verify_token=${TOKEN}`,
      'http.url': `http://localhost:3000/x?hub.verify_token=${TOKEN}`,
      'http.target': `/x?hub.verify_token=${TOKEN}`,
      'url.path': '/x',
      'http.route': '/x',
    });

    redactUrlAttributes(span);

    expect(JSON.stringify(span.attributes)).not.toContain(TOKEN);
    expect(span.attributes).toEqual({
      'url.query': `hub.verify_token=${REDACTED}`,
      'url.full': `http://localhost:3000/x?hub.verify_token=${REDACTED}`,
      'http.url': `http://localhost:3000/x?hub.verify_token=${REDACTED}`,
      'http.target': `/x?hub.verify_token=${REDACTED}`,
      'url.path': '/x',
      'http.route': '/x',
    });
  });

  it('não cria atributo que não existia nem toca nos que não são texto', () => {
    const span = spanWith({ 'url.path': '/x', 'server.port': 3000 });

    redactUrlAttributes(span);

    expect(span.setAttribute).not.toHaveBeenCalled();
    expect(span.attributes).toEqual({ 'url.path': '/x', 'server.port': 3000 });
  });

  it('span sem atributos (o que não grava nada) passa direto', () => {
    const setAttribute = vi.fn();
    expect(() => redactUrlAttributes({ setAttribute })).not.toThrow();
    expect(setAttribute).not.toHaveBeenCalled();
  });
});

describe('serializeRedisCommand', () => {
  const PHONE = '5541999990000';
  const TEXT = 'quero remarcar minha consulta de quinta';

  it('comando comum: nome e quantidade de argumentos — nem a chave, nem o valor', () => {
    expect(serializeRedisCommand('set', ['bull:whatsapp-inbound:wamid.HBgM', TEXT])).toBe('set [2 arguments]');
    expect(serializeRedisCommand('hgetall', [`bull:whatsapp-inbound:wamid.${PHONE}`])).toBe('hgetall [1 arguments]');
    expect(serializeRedisCommand('auth', ['senha-do-redis'])).toBe('auth [1 arguments]');
  });

  it('sem argumentos: só o nome', () => {
    expect(serializeRedisCommand('ping', [])).toBe('ping');
  });

  it('evalsha (como o BullMQ enfileira): fica o hash do script, o job não', () => {
    const sha = '808626431266f2e834f108cac6b35ce556927132';
    const job = Buffer.from(JSON.stringify({ to: PHONE, text: TEXT }));

    const statement = serializeRedisCommand('evalsha', [sha, 9, 'bull:messages:wait', 'bull:messages:id', job, ['aninhado', PHONE]]);

    expect(statement).toBe(`evalsha ${sha} [5 other arguments]`);
    expect(statement).not.toContain(PHONE);
    expect(serializeRedisCommand('EVALSHA', [sha])).toBe(`EVALSHA ${sha}`);
  });

  it('evalsha cujo primeiro argumento não é um hash de script não mostra argumento nenhum', () => {
    expect(serializeRedisCommand('evalsha', [TEXT, 1, 'chave'])).toBe('evalsha [3 arguments]');
  });

  it('eval leva o script inteiro como argumento, e não mostra nada dele', () => {
    expect(serializeRedisCommand('eval', ['return ARGV[1]', 1, 'chave', TEXT])).toBe('eval [4 arguments]');
  });
});
