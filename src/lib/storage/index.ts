import fs from 'fs/promises';
import path from 'path';
import { existsSync, createReadStream, createWriteStream } from 'fs';
import type { Readable } from 'stream';

export interface StorageProvider {
  save(key: string, data: Buffer | Readable): Promise<string>;
  read(key: string): Promise<Buffer>;
  readStream(key: string): Readable;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSize(key: string): Promise<number>;
  getLocalPath(key: string): string;
}

class LocalStorageProvider implements StorageProvider {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private resolvePath(key: string): string {
    // Prevent path traversal
    const resolved = path.resolve(this.basePath, key);
    if (!resolved.startsWith(path.resolve(this.basePath))) {
      throw new Error('Invalid storage key: path traversal detected');
    }
    return resolved;
  }

  async save(key: string, data: Buffer | Readable): Promise<string> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (Buffer.isBuffer(data)) {
      await fs.writeFile(filePath, data);
    } else {
      // Handle stream
      return new Promise((resolve, reject) => {
        const ws = createWriteStream(filePath);
        (data as Readable).pipe(ws);
        ws.on('finish', () => resolve(key));
        ws.on('error', reject);
      });
    }

    return key;
  }

  async read(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key);
    return fs.readFile(filePath);
  }

  readStream(key: string): Readable {
    const filePath = this.resolvePath(key);
    return createReadStream(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    return existsSync(filePath);
  }

  async getSize(key: string): Promise<number> {
    const filePath = this.resolvePath(key);
    const stat = await fs.stat(filePath);
    return stat.size;
  }

  getLocalPath(key: string): string {
    return this.resolvePath(key);
  }
}

// Singleton storage instance
let storage: StorageProvider | null = null;
let _isR2 = false;

export function getStorage(): StorageProvider {
  if (!storage) {
    const useR2 = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ACCOUNT_ID);
    const provider = process.env.STORAGE_PROVIDER || (useR2 ? 'r2' : 'local');

    console.log(`[storage] R2 env check: ACCESS_KEY=${!!process.env.R2_ACCESS_KEY_ID}, SECRET=${!!process.env.R2_SECRET_ACCESS_KEY}, ACCOUNT=${!!process.env.R2_ACCOUNT_ID}`);
    console.log(`[storage] Provider resolved to: ${provider}`);

    if (provider === 'r2') {
      const { R2StorageProvider } = require('./r2');
      storage = new R2StorageProvider();
      _isR2 = true;
      console.log('[storage] Using Cloudflare R2');
    } else {
      const basePath = process.env.STORAGE_LOCAL_PATH || './storage';
      storage = new LocalStorageProvider(path.resolve(basePath));
      _isR2 = false;
      console.log('[storage] Using local disk:', basePath);
    }
  }
  return storage!;
}

export function isR2Storage(): boolean {
  getStorage(); // ensure initialized
  return _isR2;
}
