import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { AssetCategory } from '../../asset-categories/entities/asset-category.entity';

export enum AssetStatus {
  PENDING        = 'pending',        // 업로드 완료, 변환 대기
  PROCESSING     = 'processing',     // 1단계 변환 중 (COLMAP + 빠른 splat)
  AWAITING_CROP  = 'awaiting_crop',  // mesh: Stage 1 완료, 영역 선택 대기
  DONE           = 'done',           // 2단계 풀 변환 완료
  FAILED         = 'failed',         // 변환 실패
}

export enum AssetType {
  POINT_CLOUD = 'point_cloud',
  NERF        = 'nerf',
  GAUSSIAN    = 'gaussian',
  MESH        = 'mesh',
}

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, default: () => 'gen_random_uuid()' })
  uuid: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'varchar', length: 50 })
  type: AssetType;

  @Column({ type: 'varchar', length: 50, default: AssetStatus.PENDING })
  status: AssetStatus;

  // 원본 파일 MinIO 경로
  @Column({ name: 'source_object' })
  sourceObject: string;

  // 변환 큐 job ID (삭제 시 job 취소용)
  @Column({ name: 'job_id', nullable: true })
  jobId: string;

  // 1단계 변환 결과 (fly file — 빠른 splat PLY), 미리보기용
  @Column({ name: 'preview_object', nullable: true })
  previewObject: string;

  // 2단계 변환 결과 파일 MinIO 경로 (풀 트레이닝 완료 후 저장)
  @Column({ name: 'output_object', nullable: true })
  outputObject: string;

  // 변환 진행률 (0~100)
  @Column({ type: 'int', default: 0 })
  progress: number;

  // 변환 실패 시 오류 메시지
  @Column({ name: 'error_message', nullable: true })
  errorMessage: string;

  // 승인 여부 (스튜디오 노출 제어)
  @Column({ type: 'boolean', default: false })
  approved: boolean;

  // 파일 메타데이터
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @ManyToOne(() => AssetCategory, { nullable: true, eager: false })
  @JoinColumn({ name: 'category_id' })
  category: AssetCategory;

  @Column({ name: 'category_id', nullable: true })
  categoryId: number;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ name: 'external_id', nullable: true, type: 'int' })
  externalId: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
