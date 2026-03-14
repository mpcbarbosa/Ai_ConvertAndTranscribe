import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';
import type { StorageProvider } from './index';

export class R2StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    this.bucket = process.env.R2_BUCKET_NAME || 'transcribex';

    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error('R2 credentials not configured');
    }

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async save(key: string, data: Buffer | Readable): Promise<string> {
    if (Buffer.isBuffer(data)) {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
      }));
    } else {
      // Use multipart upload for streams
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: data,
        },
        partSize: 10 * 1024 * 1024, // 10MB parts
      });
      await upload.done();
    }
    return key;
  }

  async read(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  readStream(key: string): Readable {
    // Return a passthrough stream that reads from R2
    const { PassThrough } = require('stream');
    const pass = new PassThrough();

    this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    })).then(response => {
      const body = response.Body as Readable;
      body.pipe(pass);
    }).catch(err => {
      pass.destroy(err);
    });

    return pass;
  }

  async readRange(key: string, start: number, end: number): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Range: `bytes=${start}-${end}`,
    }));
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
    } catch {
      // Ignore
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch {
      return false;
    }
  }

  async getSize(key: string): Promise<number> {
    const response = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    return response.ContentLength || 0;
  }

  getLocalPath(_key: string): string {
    throw new Error('R2 storage does not support local paths — use read/readStream instead');
  }

  /**
   * Concatenate multiple chunk keys into a single destination key using
   * S3 multipart upload. Each chunk is read individually (not all at once)
   * to stay within memory limits.
   * Note: S3 multipart requires parts >= 5MB (except last). If chunks are
   * smaller, we batch them together.
   */
  async concatenateChunks(chunkKeys: string[], destKey: string): Promise<number> {
    const MIN_PART_SIZE = 5.5 * 1024 * 1024; // 5.5MB to be safe

    // Start multipart upload
    const createRes = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: destKey,
    }));
    const uploadId = createRes.UploadId!;

    const parts: Array<{ ETag: string; PartNumber: number }> = [];
    let partNumber = 1;
    let totalSize = 0;
    let buffer = Buffer.alloc(0);

    try {
      for (let i = 0; i < chunkKeys.length; i++) {
        const chunkData = await this.read(chunkKeys[i]);
        buffer = Buffer.concat([buffer, chunkData]);
        totalSize += chunkData.length;

        const isLast = i === chunkKeys.length - 1;

        // Upload when buffer >= MIN_PART_SIZE or on last chunk
        if (buffer.length >= MIN_PART_SIZE || isLast) {
          const uploadRes = await this.client.send(new UploadPartCommand({
            Bucket: this.bucket,
            Key: destKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: buffer,
          }));
          parts.push({ ETag: uploadRes.ETag!, PartNumber: partNumber });
          partNumber++;
          buffer = Buffer.alloc(0);
        }
      }

      // Complete multipart upload
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: destKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }));

      // Delete chunks
      for (const key of chunkKeys) {
        await this.delete(key);
      }

      return totalSize;
    } catch (err) {
      // Abort multipart upload on error
      try {
        const { AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
        await this.client.send(new AbortMultipartUploadCommand({
          Bucket: this.bucket, Key: destKey, UploadId: uploadId,
        }));
      } catch { /* ignore abort errors */ }
      throw err;
    }
  }
}
