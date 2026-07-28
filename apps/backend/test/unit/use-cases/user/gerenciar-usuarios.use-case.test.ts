import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import {
  ProvisionarPrimeiroAdminUseCase,
  CriarUsuarioUseCase,
  ListarUsuariosUseCase,
  AtualizarUsuarioUseCase,
  DesativarUsuarioUseCase,
  ReativarUsuarioUseCase,
} from '@use-cases/user/gerenciar-usuarios.use-case';
import { User } from '@domain/user/user.entity';
import { TenantContext } from '@shared/tenant-context';
import { Therapist } from '@domain/therapist/therapist.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function tenantContext() {
  const tc = new TenantContext();
  tc.set(TENANT_ID, 'user-1');
  return tc;
}

function fakeTherapist() {
  return Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana' });
}

function auditMock() {
  return { recordAll: vi.fn().mockResolvedValue(undefined) } as never;
}

describe('ProvisionarPrimeiroAdminUseCase (AD-001)', () => {
  it('lança BadRequestException para senha curta', async () => {
    const repo = { provisionFirstAdmin: vi.fn(), findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn() };
    const authService = { issueTokens: vi.fn() };
    const useCase = new ProvisionarPrimeiroAdminUseCase(repo, authService as never);
    await expect(useCase.execute({ tenantId: TENANT_ID, email: 'a@b.com', password: '1234567' })).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.provisionFirstAdmin).not.toHaveBeenCalled();
  });

  it('provisiona o admin (auditoria via repositório, não via AuditService — ver ACHADO REAL em PrismaUserRepository) e emite tokens', async () => {
    const repo = {
      provisionFirstAdmin: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn(),
      findAllByTenant: vi.fn(),
      save: vi.fn(),
    };
    const authService = { issueTokens: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'b' }) };
    const useCase = new ProvisionarPrimeiroAdminUseCase(repo, authService as never);

    const result = await useCase.execute({ tenantId: TENANT_ID, email: 'admin@clinica.dev', password: 'senha-forte-123' });

    expect(repo.provisionFirstAdmin).toHaveBeenCalledOnce();
    expect(authService.issueTokens).toHaveBeenCalledWith(expect.any(String), TENANT_ID, 'admin');
    expect(result).toEqual({ accessToken: 'a', refreshToken: 'b' });
  });

  it('propaga ConflictException do repositório (Tenant já provisionado)', async () => {
    const repo = {
      provisionFirstAdmin: vi.fn().mockRejectedValue(new ConflictException('já provisionado')),
      findById: vi.fn(),
      findAllByTenant: vi.fn(),
      save: vi.fn(),
    };
    const authService = { issueTokens: vi.fn() };
    const useCase = new ProvisionarPrimeiroAdminUseCase(repo, authService as never);
    await expect(
      useCase.execute({ tenantId: TENANT_ID, email: 'admin@clinica.dev', password: 'senha-forte-123' }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('CriarUsuarioUseCase (AD-001)', () => {
  it('cria um admin sem depender do TherapistRepository', async () => {
    const repo = { save: vi.fn().mockResolvedValue(undefined), findById: vi.fn(), findAllByTenant: vi.fn(), provisionFirstAdmin: vi.fn() };
    const therapistRepo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new CriarUsuarioUseCase(repo, therapistRepo, tenantContext(), auditMock());

    const user = await useCase.execute({ email: 'admin2@clinica.dev', password: 'senha-forte-123', role: 'admin' });
    expect(user.role).toBe('admin');
    expect(therapistRepo.findById).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('lança NotFoundException quando therapistId não existe', async () => {
    const repo = { save: vi.fn(), findById: vi.fn(), findAllByTenant: vi.fn(), provisionFirstAdmin: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(null), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new CriarUsuarioUseCase(repo, therapistRepo, tenantContext(), auditMock());
    await expect(
      useCase.execute({ email: 'x@y.com', password: 'senha-forte-123', role: 'therapist', therapistId: 'nope' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('lança BadRequestException quando role=therapist sem therapistId', async () => {
    const repo = { save: vi.fn(), findById: vi.fn(), findAllByTenant: vi.fn(), provisionFirstAdmin: vi.fn() };
    const therapistRepo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new CriarUsuarioUseCase(repo, therapistRepo, tenantContext(), auditMock());
    await expect(useCase.execute({ email: 'x@y.com', password: 'senha-forte-123', role: 'therapist' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('cria um therapist quando therapistId existe', async () => {
    const repo = { save: vi.fn().mockResolvedValue(undefined), findById: vi.fn(), findAllByTenant: vi.fn(), provisionFirstAdmin: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(fakeTherapist()), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new CriarUsuarioUseCase(repo, therapistRepo, tenantContext(), auditMock());
    const user = await useCase.execute({ email: 'terapeuta@clinica.dev', password: 'senha-forte-123', role: 'therapist', therapistId: 't1' });
    expect(user.role).toBe('therapist');
    expect(user.therapistId).toBe('t1');
  });
});

describe('ListarUsuariosUseCase (AD-001)', () => {
  it('delega ao repositório com o tenantId do contexto', async () => {
    const repo = { findAllByTenant: vi.fn().mockResolvedValue([]), findById: vi.fn(), save: vi.fn(), provisionFirstAdmin: vi.fn() };
    const useCase = new ListarUsuariosUseCase(repo, tenantContext());
    await useCase.execute();
    expect(repo.findAllByTenant).toHaveBeenCalledWith(TENANT_ID);
  });
});

describe('AtualizarUsuarioUseCase (AD-001)', () => {
  it('lança NotFoundException quando o usuário não existe', async () => {
    const repo = { findById: vi.fn().mockResolvedValue(null), findAllByTenant: vi.fn(), save: vi.fn(), provisionFirstAdmin: vi.fn() };
    const therapistRepo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new AtualizarUsuarioUseCase(repo, therapistRepo, tenantContext(), auditMock());
    await expect(useCase.execute({ id: 'nope', role: 'admin' })).rejects.toThrow(NotFoundException);
  });

  it('altera o papel e persiste', async () => {
    const existing = User.create({ id: 'u1', tenantId: TENANT_ID, email: 'a@b.com', passwordHash: 'h', role: 'admin' });
    const repo = { findById: vi.fn().mockResolvedValue(existing), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), provisionFirstAdmin: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(fakeTherapist()), findAllByTenant: vi.fn(), save: vi.fn() };
    const useCase = new AtualizarUsuarioUseCase(repo, therapistRepo, tenantContext(), auditMock());
    const user = await useCase.execute({ id: 'u1', role: 'therapist', therapistId: 't1' });
    expect(user.role).toBe('therapist');
    expect(repo.save).toHaveBeenCalledOnce();
  });
});

describe('DesativarUsuarioUseCase (AD-001)', () => {
  it('lança NotFoundException quando o usuário não existe', async () => {
    const repo = { findById: vi.fn().mockResolvedValue(null), findAllByTenant: vi.fn(), save: vi.fn(), provisionFirstAdmin: vi.fn() };
    const useCase = new DesativarUsuarioUseCase(repo, tenantContext(), auditMock());
    await expect(useCase.execute('nope')).rejects.toThrow(NotFoundException);
  });

  it('desativa e persiste', async () => {
    const existing = User.create({ id: 'u1', tenantId: TENANT_ID, email: 'a@b.com', passwordHash: 'h', role: 'admin' });
    const repo = { findById: vi.fn().mockResolvedValue(existing), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), provisionFirstAdmin: vi.fn() };
    const useCase = new DesativarUsuarioUseCase(repo, tenantContext(), auditMock());
    const user = await useCase.execute('u1');
    expect(user.isActive).toBe(false);
  });
});

describe('ReativarUsuarioUseCase (AD-001)', () => {
  it('lança NotFoundException quando o usuário não existe', async () => {
    const repo = { findById: vi.fn().mockResolvedValue(null), findAllByTenant: vi.fn(), save: vi.fn(), provisionFirstAdmin: vi.fn() };
    const useCase = new ReativarUsuarioUseCase(repo, tenantContext(), auditMock());
    await expect(useCase.execute('nope')).rejects.toThrow(NotFoundException);
  });

  it('reativa e persiste', async () => {
    const existing = User.reconstitute({
      id: 'u1',
      tenantId: TENANT_ID,
      email: 'a@b.com',
      passwordHash: 'h',
      role: 'admin',
      deletedAt: new Date(),
    });
    const repo = { findById: vi.fn().mockResolvedValue(existing), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), provisionFirstAdmin: vi.fn() };
    const useCase = new ReativarUsuarioUseCase(repo, tenantContext(), auditMock());
    const user = await useCase.execute('u1');
    expect(user.isActive).toBe(true);
  });
});
