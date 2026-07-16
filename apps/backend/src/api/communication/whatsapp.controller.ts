import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ConectarWhatsAppUseCase } from '@use-cases/communication/conectar-whatsapp.use-case';

class ConnectWhatsAppDto {
  @IsString()
  @MinLength(1)
  phoneNumberId!: string;

  @IsString()
  @MinLength(1)
  accessToken!: string;
}

/**
 * WhatsAppController — cada clínica conecta seu próprio canal.
 * Restrito a admin.
 */
@ApiTags('whatsapp')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly conectarWhatsApp: ConectarWhatsAppUseCase) {}

  @Post('connect')
  @Roles('admin')
  async connect(@Body() dto: ConnectWhatsAppDto) {
    await this.conectarWhatsApp.execute(dto);
    return { status: 'connected' };
  }
}
