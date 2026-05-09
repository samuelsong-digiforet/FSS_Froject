import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: Minio.Client;
  private readonly bucket: string;
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('MINIO_BUCKET') ?? 'fss-uploads';
    this.client = new Minio.Client({
      endPoint: this.config.get<string>('MINIO_ENDPOINT') ?? 'minio',
      port: Number(this.config.get('MINIO_PORT') ?? 9000),
      useSSL: false,
      accessKey: this.config.get<string>('MINIO_ROOT_USER') ?? 'fss_admin',
      secretKey: this.config.get<string>('MINIO_ROOT_PASSWORD') ?? 'fss_minio_secret_2024',
    });
  }

  async onModuleInit(): Promise<void> {
    // MinIO가 아직 준비되지 않은 경우를 대비해 재시도 (최대 10회, 3초 간격)
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const exists = await this.client.bucketExists(this.bucket);
        if (!exists) {
          await this.client.makeBucket(this.bucket, 'ap-northeast-2');
          this.logger.log(`Bucket creation complete: ${this.bucket}`);
        } else {
          this.logger.log(`Bucket confirmed complete: ${this.bucket}`);
        }
        return;
      } catch (err) {
        this.logger.warn(`MinIO 연결 실패 (${attempt}/10): ${(err as Error).message}`);
        if (attempt === 10) throw err;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  // 파일 업로드 → 저장 경로(objectName) 반환
  async upload(
    objectName: string,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    await this.client.putObject(this.bucket, objectName, buffer, buffer.length, {
      'Content-Type': mimetype,
    });
    return objectName;
  }

  // 다운로드용 임시 URL 생성 (1시간 유효)
  async getPresignedUrl(objectName: string): Promise<string> {
    const url = await this.client.presignedGetObject(this.bucket, objectName, 60 * 60);
    // Docker 내부 호스트명을 브라우저에서 접근 가능한 주소로 교체
    return url.replace('http://minio:9000', 'http://localhost:9000');
  }

  // 파일 메타데이터 반환 (크기 등)
  async statObject(objectName: string) {
    return this.client.statObject(this.bucket, objectName);
  }

  // 파일 스트림 반환
  async getObjectStream(objectName: string) {
    return this.client.getObject(this.bucket, objectName);
  }

  // 파일 삭제
  async delete(objectName: string): Promise<void> {
    await this.client.removeObject(this.bucket, objectName);
  }
}