import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as Minio from 'minio';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: Minio.Client;
  private readonly bucket: string;
  private readonly extS3: S3Client;
  private readonly extBucket: string;
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

    this.extBucket = this.config.get<string>('EXT_S3_BUCKET') ?? 'dt-storage';
    this.extS3 = new S3Client({
      region: this.config.get<string>('EXT_S3_REGION') ?? 'us-east-1',
      endpoint: this.config.get<string>('EXT_S3_ENDPOINT'),
      credentials: {
        accessKeyId: this.config.get<string>('EXT_S3_ACCESS_KEY') ?? '',
        secretAccessKey: this.config.get<string>('EXT_S3_SECRET_KEY') ?? '',
      },
      forcePathStyle: true,
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
    const publicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? 'http://localhost:9000';
    return url.replace('http://minio:9000', publicUrl);
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

  async copyToExternal(sourceObjectName: string, targetObjectName = sourceObjectName): Promise<void> {
    if (!this.config.get<string>('EXT_S3_ENDPOINT')) {
      throw new Error('EXT_S3_ENDPOINT is not configured');
    }

    const stat = await this.client.statObject(this.bucket, sourceObjectName);
    const stream = await this.client.getObject(this.bucket, sourceObjectName);
    await this.extS3.send(new PutObjectCommand({
      Bucket: this.extBucket,
      Key: targetObjectName,
      Body: stream,
      ContentLength: stat.size,
      ACL: 'public-read',
    }));
  }
}
