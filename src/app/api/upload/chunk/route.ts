import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '../../../../lib/storage';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';

/**
 * Receive a single chunk of a file upload.
 * Each chunk is max ~50MB, well within Render's 100MB proxy limit.
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

    // Validate uploadId format (prevent path traversal)
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) {
      return NextResponse.json({ error: 'Invalid upload ID' }, { status: 400 });
    }

    const storage = getStorage();
    const chunksDir = path.join(storage.getLocalPath(''), 'chunks', uploadId);

    // Ensure directory exists
    await fs.mkdir(chunksDir, { recursive: true });

    // Save chunk to disk
    const chunkPath = path.join(chunksDir, `chunk_${String(chunkIndex).padStart(5, '0')}`);
    const buffer = Buffer.from(await chunk.arrayBuffer());
    await fs.writeFile(chunkPath, buffer);

    return NextResponse.json({
      uploadId,
      chunkIndex: parseInt(chunkIndex),
      size: buffer.length,
    });
  } catch (err) {
    console.error('Chunk upload error:', err);
    return NextResponse.json({ error: 'Failed to upload chunk' }, { status: 500 });
  }
}
