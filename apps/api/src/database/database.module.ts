import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { User } from '../users/entities/user.entity';
import { AssetCategory } from '../asset-categories/entities/asset-category.entity';
import { Asset } from '../assets/entities/asset.entity';
import { Log } from '../logs/log.entity';
import { RolePermission } from '../roles/entities/role-permission.entity';
import { Role } from '../roles/entities/role.entity';
import { Scene } from '../scenes/entities/scene.entity';
import { SeederService } from './seeder.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST'),
        port: config.get<number>('DB_PORT'),
        database: config.get<string>('DB_NAME'),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASS'),
        entities: [User, AssetCategory, Asset, Log, Role, RolePermission, Scene],
        synchronize: config.get<string>('NODE_ENV') !== 'production', // 개발 환경에서만 자동 마이그레이션
        logging: config.get<string>('NODE_ENV') === 'development',
      }),
    }),
    TypeOrmModule.forFeature([User]),
  ],
  providers: [SeederService],
})
export class DatabaseModule {}
