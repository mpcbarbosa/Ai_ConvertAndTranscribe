import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
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
}
