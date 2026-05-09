import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Role } from './role.entity';

export enum MenuKey {
  DASHBOARD        = 'dashboard',
  STUDIO           = 'studio',
  ASSET_CATEGORY   = 'asset_category',
  ASSET_MANAGE     = 'asset_manage',
  SYS_USERS        = 'sys_users',
  SYS_PERMISSIONS  = 'sys_permissions',
  SYS_LOGS         = 'sys_logs',
}

@Entity('role_permissions')
export class RolePermission {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role: Role;

  @Column({ name: 'role_id' })
  roleId: number;

  @Column({ type: 'varchar', name: 'menu_key' })
  menuKey: string;

  @Column({ default: false }) use: boolean;
  @Column({ default: false }) view: boolean;
  @Column({ default: false }) detail: boolean;
  @Column({ default: false }) create: boolean;
  @Column({ default: false }) update: boolean;
  @Column({ default: false }) delete: boolean;
  @Column({ default: false }) approve: boolean;
  @Column({ default: false }) editor: boolean;
  @Column({ default: false }) excel: boolean;
}