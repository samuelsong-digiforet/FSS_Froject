import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'asset_file' })
export class ExtAssetFile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'model_key' })
  modelKey: string;

  @Column({ name: 'cover_key' })
  coverKey: string;

  @Column({ name: 'strip_key' })
  stripKey: string;

  @Column({ name: 'file_ext' })
  fileExt: string;

  @Column({ name: 'file_size', type: 'bigint' })
  fileSize: string;

  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt: Date | null;
}
