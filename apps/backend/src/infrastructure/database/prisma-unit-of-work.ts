import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '@domain-services/platform/unit-of-work';
import { PrismaService } from './prisma.service';

/**
 * PrismaUnitOfWork — ADR-0063 (AD-038). A unidade de trabalho é a própria
 * transação do PrismaService: os repositórios continuam chamando
 * forTenant(), que entra nela enquanto estiver aberta.
 */
@Injectable()
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.prisma.inUnitOfWork(work);
  }
}
