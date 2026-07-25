import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      // expiresIn não é global aqui — cada token define o próprio expiresIn
      // em AuthService.issueTokens(), porque access e refresh têm durações
      // diferentes.
    }),
    // AD-006 — rate limiting de POST /auth/login. Registrado só aqui (não
    // em AppModule) porque o throttle desta AD é escopado deliberadamente
    // ao endpoint de login via @UseGuards(ThrottlerGuard) no
    // AuthController, nunca aplicado globalmente a toda a API. Limite/TTL
    // configuráveis via ambiente (mesmo padrão de JWT_EXPIRES_IN) — nunca
    // hardcoded, para permitir override em ambientes diferentes (ver
    // test/critical/support/global-setup.ts, que eleva o limite só para a
    // Suíte Crítica, sem o que ela quebraria: dezenas de logins reais por
    // execução, de dentro do mesmo processo/IP).
    //
    // forRootAsync(), não forRoot(): um objeto literal passado a forRoot()
    // é avaliado no momento em que este módulo é CARREGADO (evaluation da
    // metadata do decorator @Module(), disparada pela cadeia de import
    // estática — acontece antes de qualquer beforeAll de teste rodar).
    // forRootAsync() com useFactory adia a leitura de process.env para o
    // momento em que o Nest de fato instancia o módulo (compile()) —
    // necessário para que test/critical/auth-login-throttle.test.ts consiga
    // sobrescrever o limite ANTES de bootstrapTestApp() e ver esse valor
    // refletido (descoberto na prática: com forRoot(), a sobrescrita nunca
    // tinha efeito nenhum, o valor de global-setup.ts sempre prevalecia).
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [
          {
            name: 'auth-login',
            ttl: Number(process.env.AUTH_THROTTLE_TTL_MS ?? 60000),
            limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 5),
          },
        ],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard, PrismaService, PrismaClientProvider],
  exports: [JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
