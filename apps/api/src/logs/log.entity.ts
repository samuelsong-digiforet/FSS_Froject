import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('logs')
export class Log {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  userId: string;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  fullName: string;

  @Column({ nullable: true })
  ip: string;

  @Column({ nullable: true })
  device: string;

  @Column({ nullable: true })
  menuName: string;

  @Column({ nullable: true })
  action: string;

  @CreateDateColumn()
  createdAt: Date;
}
