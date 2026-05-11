import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { LogsService } from './logs.service';
import { LOG_META_KEY } from './log.decorator';

@Injectable()
export class LogsInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly logsService: LogsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<{ menuName: string; action: string }>(
      LOG_META_KEY,
      context.getHandler(),
    );

    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest<{ user?: { id: string; username?: string; email: string; fullName: string }; ip: string; headers: Record<string, string> }>();
    const user = req.user;
    const ip = (req.headers['x-forwarded-for'] as string) ?? req.ip;

    return next.handle().pipe(
      tap(() => {
        if (!user) return;
        this.logsService
          .record({
            userId: user.id,
            username: user.username ?? user.email,
            fullName: user.fullName,
            ip,
            device: '웹',
            menuName: meta.menuName,
            action: meta.action,
          })
          .catch(() => null);
      }),
    );
  }
}
