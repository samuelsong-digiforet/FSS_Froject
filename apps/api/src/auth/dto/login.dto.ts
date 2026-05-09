import { IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  username: string; // 이메일 대신 아이디로 로그인

  @IsString()
  password: string;
}