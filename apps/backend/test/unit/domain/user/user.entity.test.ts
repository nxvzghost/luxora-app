import { describe, it, expect } from 'vitest';
import { User } from '@domain/user/user.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function adminProps() {
  return { id: 'u1', tenantId: TENANT_ID, email: 'admin@clinica.dev', passwordHash: 'hash', role: 'admin' as const };
}

describe('User (AD-001)', () => {
  it('cria um admin sem therapistId', () => {
    const user = User.create(adminProps());
    expect(user.role).toBe('admin');
    expect(user.therapistId).toBeUndefined();
    expect(user.isActive).toBe(true);
  });

  it('cria um therapist com therapistId', () => {
    const user = User.create({ ...adminProps(), role: 'therapist', therapistId: 't1' });
    expect(user.role).toBe('therapist');
    expect(user.therapistId).toBe('t1');
  });

  it('lança erro ao criar therapist sem therapistId', () => {
    expect(() => User.create({ ...adminProps(), role: 'therapist' })).toThrow(/therapistId/);
  });

  it('lança erro ao criar admin com therapistId', () => {
    expect(() => User.create({ ...adminProps(), role: 'admin', therapistId: 't1' })).toThrow(/não pode referenciar/);
  });

  it('lança erro com e-mail inválido', () => {
    expect(() => User.create({ ...adminProps(), email: 'nao-e-email' })).toThrow(/E-mail inválido/);
  });

  it('desativa e reativa, alternando isActive/deletedAt', () => {
    const user = User.create(adminProps());
    expect(user.isActive).toBe(true);
    user.deactivate();
    expect(user.isActive).toBe(false);
    expect(user.deletedAt).toBeInstanceOf(Date);
    user.reactivate();
    expect(user.isActive).toBe(true);
    expect(user.deletedAt).toBeNull();
  });

  it('lança erro ao desativar um usuário já desativado', () => {
    const user = User.create(adminProps());
    user.deactivate();
    expect(() => user.deactivate()).toThrow(/já está desativado/);
  });

  it('lança erro ao reativar um usuário já ativo', () => {
    const user = User.create(adminProps());
    expect(() => user.reactivate()).toThrow(/já está ativo/);
  });

  it('changeRole valida os mesmos invariantes de create()', () => {
    const user = User.create(adminProps());
    expect(() => user.changeRole('therapist')).toThrow(/therapistId/);
    user.changeRole('therapist', 't2');
    expect(user.role).toBe('therapist');
    expect(user.therapistId).toBe('t2');
  });

  it('markCreated/deactivate/reactivate/changeRole enfileiram eventos, pullDomainEvents esvazia', () => {
    const user = User.create(adminProps());
    user.markCreated();
    user.changeRole('therapist', 't3');
    user.deactivate();
    user.reactivate();

    const events = user.pullDomainEvents();
    expect(events).toHaveLength(4);
    expect(user.pullDomainEvents()).toHaveLength(0);
  });

  it('reconstitute() preserva o estado exato, incluindo deletedAt', () => {
    const deletedAt = new Date('2026-01-01T00:00:00Z');
    const user = User.reconstitute({ ...adminProps(), deletedAt });
    expect(user.isActive).toBe(false);
    expect(user.deletedAt).toEqual(deletedAt);
  });
});
