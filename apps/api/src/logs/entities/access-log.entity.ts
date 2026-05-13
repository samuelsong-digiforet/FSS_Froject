import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('access_logs')
export class AccessLog {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', nullable: true })
  userId: number;

  @Column({ nullable: true })
  username: string;

  @Column({ name: 'full_name', nullable: true })
  fullName: string;

  @Column({ nullable: true })
  ip: string;

  @Column({ default: '웹' })
  device: string;

  @Column({ name: 'menu_name', nullable: true })
  menuName: string;

  @Column({ nullable: true })
  action: string;

  @CreateDateColumn({ name: 'accessed_at' })
  accessedAt: Date;
}