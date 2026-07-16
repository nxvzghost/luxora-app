import { IsEmail, IsString, MinLength } from 'class-validator';

/**
 * LoginDto — contrato de entrada de POST /api/v1/auth/login.
 * Fonte: 02 - CTO/clinicos/docs/04-API/01-Contratos-REST.md, seção Auth.
 */
export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
