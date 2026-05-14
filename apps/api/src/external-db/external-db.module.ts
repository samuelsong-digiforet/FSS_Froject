import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExtAssetFile } from './entities/ext-asset-file.entity';
import { ExtAsset } from './entities/ext-asset.entity';
import { ExtCategory } from './entities/ext-category.entity';
import { ExternalDbConnectionService } from './external-db.connection.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'external',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('EXT_DB_HOST'),
        port: config.get<number>('EXT_DB_PORT') ?? 5432,
        database: config.get<string>('EXT_DB_NAME'),
        username: config.get<string>('EXT_DB_USER'),
        password: config.get<string>('EXT_DB_PASS'),
        entities: [ExtCategory, ExtAsset, ExtAssetFile],
        synchronize: false,
        logging: false,
        retryAttempts: 0,
        connectTimeoutMS: 3000,
        manualInitialization: true,
      }),
    }),
    TypeOrmModule.forFeature([ExtCategory, ExtAsset, ExtAssetFile], 'external'),
  ],
  providers: [ExternalDbConnectionService],
  exports: [TypeOrmModule],
})
export class ExternalDbModule {}
