import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const cleanDir = async (dir: string): Promise<{ files: number; bytes: number }> => {
  let files = 0;
  let bytes = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await cleanDir(fullPath);
        files += sub.files;
        bytes += sub.bytes;
        await fs.rmdir(fullPath).catch(() => {});
      } else {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat) bytes += stat.size;
        await fs.unlink(fullPath).catch(() => {});
        files++;
      }
    }
  } catch { /* dir doesn't exist */ }
  return { files, bytes };
};

export async function POST() {
  try {
    const storagePath = path.resolve(process.env.STORAGE_LOCAL_PATH || '/opt/render/project/storage');
    const { files, bytes } = await cleanDir(storagePath);
    return NextResponse.json({
      ok: true, freedFiles: files, freedMB: Math.round(bytes / 1024 / 1024),
      message: `Cleaned ${files} files, freed ${Math.round(bytes / 1024 / 1024)} MB`,
    });
  } catch (err) {
    console.error('Cleanup error:', err);
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 });
  }
}
