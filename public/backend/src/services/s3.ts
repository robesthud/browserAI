// ============================================
// AI CODE STUDIO - S3 STORAGE SERVICE
// Supports AWS S3, MinIO, and other S3-compatible APIs
// Falls back to local storage if not configured
// ============================================

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';

// Config
const S3_BUCKET = process.env.S3_BUCKET || 'aicode-blobs';
const S3_ENDPOINT = process.env.S3_ENDPOINT || ''; // e.g., 'http://localhost:9000' for MinIO
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || '';
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || '';

const LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || './data/blobs';

const isS3Configured = Boolean(S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);

let s3Client: S3Client | null = null;
if (isS3Configured) {
  s3Client = new S3Client({
    endpoint: S3_ENDPOINT || undefined,
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: Boolean(S3_ENDPOINT), // Required for MinIO
  });
  console.log('🪣 S3 Storage initialized (AWS S3/MinIO)');
} else {
  console.log('📂 S3 Storage not configured. Falling back to local filesystem storage.');
}

export class S3StorageService {
  /**
   * Upload file to S3 or local directory
   */
  static async upload(fileKey: string, content: Buffer | string, contentType = 'text/plain'): Promise<string> {
    const dataBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

    if (isS3Configured && s3Client) {
      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: fileKey,
            Body: dataBuffer,
            ContentType: contentType,
          })
        );
        // Return S3 URL
        const domain = S3_ENDPOINT ? S3_ENDPOINT : `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
        return `${domain}/${S3_BUCKET}/${fileKey}`;
      } catch (error) {
        console.error('S3 Upload Error, falling back to local:', error);
      }
    }

    // Local filesystem storage fallback
    const localPath = join(LOCAL_STORAGE_DIR, fileKey);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, dataBuffer);
    return `/api/files/blob/${fileKey}`;
  }

  /**
   * Read file from S3 or local directory
   */
  static async read(fileKey: string): Promise<Buffer> {
    if (isS3Configured && s3Client) {
      try {
        const response = await s3Client.send(
          new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: fileKey,
          })
        );
        if (response.Body) {
          const bytes = await response.Body.transformToByteArray();
          return Buffer.from(bytes);
        }
      } catch (error) {
        console.error('S3 Read Error, trying local:', error);
      }
    }

    // Local fallback
    const localPath = join(LOCAL_STORAGE_DIR, fileKey);
    return readFile(localPath);
  }

  /**
   * Delete file from S3 or local directory
   */
  static async delete(fileKey: string): Promise<void> {
    if (isS3Configured && s3Client) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: S3_BUCKET,
            Key: fileKey,
          })
        );
        return;
      } catch (error) {
        console.error('S3 Delete Error, trying local:', error);
      }
    }

    // Local fallback
    const localPath = join(LOCAL_STORAGE_DIR, fileKey);
    try {
      await unlink(localPath);
    } catch {}
  }
}
