import { NextRequest, NextResponse } from 'next/server';
import { getStorage, isR2Storage } from '../../../../lib/storage';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';

/**
 * Receive a single chunk. Stored in R2 or local disk.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const chunk = formData.get('chunk') as File | null;
    const uploadId = formData.get('uploadId') as string;
    const chunkIndex = formData.get('chunkIndex') as string;

    if (!chunk || !uploadId || chunkIndex === null) {
      return NextResponse.json({ error: 'Missing chunk data' }, { status: 400 });
    }
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) {
      return NextResponse.json({ error: 'Invalid upload ID' }, { status: 400 });
    }

    const buffer = Buffer.from(await chunk.arrayBuffer());
    const chunkKey = `chunks/${uploadId}/chunk_${String(chunkIndex).padStart(5, '0')}`;

    if (isR2Storage()) {
      // Save directly to R2
      const storage = getStorage();
      await storage.save(chunkKey, buffer);
    } else {
      // Save to local disk
      const storage = getStorage();
      const chunksDir = path.join(storage.getLocalPath(''), 'chunks', uploadId);
      await fs.mkdir(chunksDir, { recursive: true });
      const chunkPath = path.join(chunksDir, `chunk_${String(chunkIndex).padStart(5, '0')}`);
      await fs.writeFile(chunkPath, buffer);
    }

    return NextResponse.json({ uploadId, chunkIndex: parseInt(chunkIndex), size: buffer.length });
  } catch (err) {
    console.error('Chunk upload error:', err);
    return NextResponse.json({ error: 'Failed to upload chunk' }, { status: 500 });
  }
}
