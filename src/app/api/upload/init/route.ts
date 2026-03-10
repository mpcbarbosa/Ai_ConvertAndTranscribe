import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getStorage } from '../../../../lib/storage';
import fs from 'fs/promises';
import path from 'path';

/**
 * Initialize a chunked upload session.
 * Returns an uploadId that the client uses to send chunks.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { fileName, fileSize, mimeType, totalChunks } = body;

    if (!fileName || !fileSize || !totalChunks) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const uploadId = uuidv4();

    // Create temp directory for chunks
    const storage = getStorage();
    const chunksDir = path.join(storage.getLocalPath(''), 'chunks', uploadId);
    await fs.mkdir(chunksDir, { recursive: true });

    return NextResponse.json({
      uploadId,
      fileName,
      fileSize,
      mimeType,
      totalChunks,
    });
  } catch (err) {
    console.error('Upload init error:', err);
    return NextResponse.json({ error: 'Failed to initialize upload' }, { status: 500 });
  }
}
