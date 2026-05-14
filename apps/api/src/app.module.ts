import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { RolesModule } from './roles/roles.module';
import * as Joi from 'joi';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UploadsModule } from './uploads/uploads.module';
import { AssetsModule } from './assets/assets.module';
import { QueueModule } from './queue/queue.module';
import { UsersModule } from './users/users.module';
import { LogsModule } from './logs/logs.module';
import { AssetCategoriesModule } from './asset-categories/asset-categories.module';
import { ScenesModule } from './scenes/scenes.module';
import { ExternalDbModule } from './external-db/external-db.module';
import { HealthController } from './health/health.controller';

const hasExternalDbConfig = [
  'EXT_DB_HOST',
  'EXT_DB_NAME',
  'EXT_DB_USER',
  'EXT_DB_PASS',
].every((key) => Boolean(process.env[key]));

const optionalModules = hasExternalDbConfig ? [ExternalDbModule] : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        DB_HOST: Joi.string().required(),
        DB_PORT: Joi.number().default(5432),
        DB_NAME: Joi.string().required(),
        DB_USER: Joi.string().required(),
        DB_PASS: Joi.string().required(),
        JWT_SECRET: Joi.string().min(32).required(),
      }).options({ allowUnknown: true }),
    }),
    DatabaseModule,
    ...optionalModules,
    QueueModule,
    AuthModule,
    UploadsModule,
    AssetsModule,
    RolesModule,
    UsersModule,
    LogsModule,
    AssetCategoriesModule,
    ScenesModule,
    TerminusModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
