import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ExtAssetFile } from './ext-asset-file.entity';
import { ExtCategory } from './ext-category.entity';

@Entity({ name: 'asset' })
export class ExtAsset {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string | null;

  @ManyToOne(() => ExtCategory, { nullable: false, eager: false })
  @JoinColumn({ name: 'category_id' })
  category: ExtCategory;

  @Column({ name: 'category_id' })
  categoryId: number;

  @ManyToOne(() => ExtAssetFile, { nullable: false, eager: false })
  @JoinColumn({ name: 'asset_file_id' })
  assetFile: ExtAssetFile;

  @Column({ name: 'asset_file_id' })
  assetFileId: number;

  @Column({ name: 'is_approve', type: 'boolean', default: false })
  isApprove: boolean;

  @Column({ name: 'created_by_id', nullable: true })
  createdById: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt: Date | null;
}
