import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../lib/db/client';
import { getStorage } from '../../../../lib/storage';
import { enqueueJob } from '../../../../lib/queue';
import { sanitizeFileName, isVideoFile, getFileExtension } from '../../../../lib/utils';
import { SUPPORTED_EXTENSIONS } from '../../../../types';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

/**
 * Complete a chunked upload: reassemble chunks, create job, enqueue.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      uploadId, fileName, fileSize, mimeType, totalChunks,
      sourceLanguage, targetLanguage, processingMode, uiLanguage,
    } = body;

    if (!uploadId || !fileName || !totalChunks) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Validate uploadId
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) {
      return NextResponse.json({ error: 'Invalid upload ID' }, { status: 400 });
    }

    // Validate file extension
    const ext = getFileExtension(fileName);
    if (!SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])) {
      return NextResponse.json({ error: `Unsupported file type: ${ext}` }, { status: 400 });
    }

    const storage = getStorage();
    const chunksDir = path.join(storage.getLocalPath(''), 'chunks', uploadId);

    // Verify all chunks exist
    const chunkFiles: string[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunksDir, `chunk_${String(i).padStart(5, '0')}`);
      try {
        await fs.access(chunkPath);
        chunkFiles.push(chunkPath);
      } catch {
        return NextResponse.json({ error: `Missing chunk ${i}` }, { status: 400 });
      }
    }

    // Reassemble file
    const safeFileName = sanitizeFileName(fileName);
    const storageKey = `uploads/${uuidv4()}/${safeFileName}`;
    const finalPath = storage.getLocalPath(storageKey);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    // Concatenate chunks into final file
    const writeHandle = await fs.open(finalPath, 'w');
    try {
      for (const chunkPath of chunkFiles) {
        const chunkData = await fs.readFile(chunkPath);
        await writeHandle.write(chunkData);
      }
    } finally {
      await writeHandle.close();
    }

    // Get actual file size
    const stat = await fs.stat(finalPath);
    const actualSize = stat.size;

    // Clean up chunks
    await fs.rm(chunksDir, { recursive: true, force: true }).catch(() => {});

    // Determine source type
    const effectiveMime = mimeType || 'application/octet-stream';
    const isVideo = isVideoFile(effectiveMime) || ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext);
    const sourceType = isVideo ? 'video' : 'audio';

    // Create job
    const job = await prisma.job.create({
      data: {
        originalFileName: fileName,
        originalMimeType: effectiveMime,
        originalFileSize: BigInt(actualSize),
        sourceType: sourceType as 'video' | 'audio',
        sourceLanguage: sourceLanguage || null,
        targetLanguage: targetLanguage || null,
        uiLanguage: uiLanguage || 'en',
        processingMode: processingMode === 'best_quality' ? 'best_quality' : 'balanced',
        status: 'uploaded',
      },
    });

    // Create original file artifact
    await prisma.jobArtifact.create({
      data: {
        jobId: job.id,
        type: 'original',
        storagePath: storageKey,
        mimeType: effectiveMime,
        sizeBytes: BigInt(actualSize),
      },
    });

    // Enqueue
    await enqueueJob(job.id);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'queued' },
    });

    return NextResponse.json({
      id: job.id,
      status: 'queued',
      fileName,
      fileSize: actualSize,
    });
  } catch (err) {
    console.error('Upload complete error:', err);
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 });
  }
}
