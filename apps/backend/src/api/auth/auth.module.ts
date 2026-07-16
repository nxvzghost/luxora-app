import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { TenantContext } from '@shared/tenant-context';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      // expiresIn não é global aqui — cada token define o próprio expiresIn
      // em AuthService.issueTokens(), porque access e refresh têm durações
      // diferentes.
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard, PrismaService, PrismaClientProvider, TenantContext],
  exports: [JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
