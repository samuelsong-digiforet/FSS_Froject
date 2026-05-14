import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class ExternalDbConnectionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExternalDbConnectionService.name);
  private hasAttemptedInitialization = false;

  constructor(
    @InjectDataSource('external')
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.initializeInBackground();
  }

  private async initializeInBackground(): Promise<void> {
    if (this.hasAttemptedInitialization || this.dataSource.isInitialized) {
      return;
    }

    this.hasAttemptedInitialization = true;

    const host = this.config.get<string>('EXT_DB_HOST');
    const port = this.config.get<number>('EXT_DB_PORT') ?? 5432;

    if (!host) {
      this.logger.warn('External DB host is not configured. Skipping external DB initialization.');
      return;
    }

    try {
      await this.dataSource.initialize();
      this.logger.log(`External DB connected: ${host}:${port}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `External DB is unreachable (${host}:${port}). Continuing without it for now. ${message}`,
      );
    }
  }
}
