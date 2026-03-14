import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

/**
 * Cleanup local disk storage to free space.
 * Deletes all files in /opt/render/project/storage/
 * Safe to call when using R2 (files are in cloud).
 */
export async function POST() {
  try {
    const storagePath = process.env.STORAGE_LOCAL_PATH || '/opt/render/project/storage';
    const resolvedPath = path.resolve(storagePath);

    // List and delete contents
    let freedFiles = 0;
    let freedBytes = 0;

    async function cleanDir(dir: string) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await cleanDir(fullPath);
            await fs.rmdir(fullPath).catch(() => {});
          } else {
            const stat = await fs.stat(fullPath).catch(() => null);
            if (stat) freedBytes += stat.size;
            await fs.unlink(fullPath).catch(() => {});
            freedFiles++;
          }
        }
      } catch { /* dir doesn't exist */ }
    }

    await cleanDir(resolvedPath);

    return NextResponse.json({
      ok: true,
      freedFiles,
      freedMB: Math.round(freedBytes / 1024 / 1024),
      message: `Cleaned ${freedFiles} files, freed ${Math.round(freedBytes / 1024 / 1024)} MB`,
    });
  } catch (err) {
    console.error('Cleanup error:', err);
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 });
  }
}
