import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../lib/db/client';
import { getStorage } from '../../../../lib/storage';
import { enqueueJob } from '../../../../lib/queue';
import { sanitizeFileName, isVideoFile, getFileExtension } from '../../../../lib/utils';
import { SUPPORTED_EXTENSIONS } from '../../../../types';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

interface UploadInfo {
  uploadId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
}

async function reassembleFile(upload: UploadInfo, storage: ReturnType<typeof getStorage>): Promise<{ storagePath: string; actualSize: number }> {
  const chunksDir = path.join(storage.getLocalPath(''), 'chunks', upload.uploadId);
  const safeFileName = sanitizeFileName(upload.fileName);
  const storagePath = `uploads/${uuidv4()}/${safeFileName}`;
  const finalPath = storage.getLocalPath(storagePath);

  await fs.mkdir(path.dirname(finalPath), { recursive: true });

  const writeHandle = await fs.open(finalPath, 'w');
  try {
    for (let i = 0; i < upload.totalChunks; i++) {
      const chunkPath = path.join(chunksDir, `chunk_${String(i).padStart(5, '0')}`);
      const chunkData = await fs.readFile(chunkPath);
      await writeHandle.write(chunkData);
    }
  } finally {
    await writeHandle.close();
  }

  const stat = await fs.stat(finalPath);
  await fs.rm(chunksDir, { recursive: true, force: true }).catch(() => {});

  return { storagePath, actualSize: stat.size };
}

/**
 * Complete upload: reassemble chunks, create job, enqueue.
 * Supports single file (legacy) or multiple files (multi-part meeting).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sourceLanguage, targetLanguage, processingMode, uiLanguage } = body;

    // Multi-file: body.uploads is an array; single-file: use legacy fields
    const uploads: UploadInfo[] = body.uploads || [{
      uploadId: body.uploadId,
      fileName: body.fileName,
      fileSize: body.fileSize,
      mimeType: body.mimeType,
      totalChunks: body.totalChunks,
    }];

    if (uploads.length === 0 || !uploads[0].uploadId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Validate all uploadIds
    for (const u of uploads) {
      if (!/^[0-9a-f-]{36}$/.test(u.uploadId)) {
        return NextResponse.json({ error: `Invalid upload ID: ${u.uploadId}` }, { status: 400 });
      }
      const ext = getFileExtension(u.fileName);
      if (!SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])) {
        return NextResponse.json({ error: `Unsupported file type: ${ext}` }, { status: 400 });
      }
    }

    const storage = getStorage();

    // Reassemble all files
    const files: Array<{ storagePath: string; actualSize: number; fileName: string; mimeType: string }> = [];
    for (const upload of uploads) {
      const { storagePath, actualSize } = await reassembleFile(upload, storage);
      files.push({ storagePath, actualSize, fileName: upload.fileName, mimeType: upload.mimeType });
    }

    const primaryFile = files[0];
    const totalSize = files.reduce((s, f) => s + f.actualSize, 0);
    const allFileNames = files.map(f => f.fileName).join(' + ');
    const ext = getFileExtension(primaryFile.fileName);
    const isVideo = isVideoFile(primaryFile.mimeType) || ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext);
    const sourceType = isVideo ? 'video' : 'audio';

    // Create job
    const job = await prisma.job.create({
      data: {
        originalFileName: allFileNames,
        originalMimeType: primaryFile.mimeType,
        originalFileSize: BigInt(totalSize),
        sourceType: sourceType as 'video' | 'audio',
        sourceLanguage: sourceLanguage || null,
        targetLanguage: targetLanguage || null,
        uiLanguage: uiLanguage || 'en',
        processingMode: processingMode === 'best_quality' ? 'best_quality' : 'balanced',
        status: 'uploaded',
      },
    });

    // Create artifacts for each file (in order)
    for (let i = 0; i < files.length; i++) {
      await prisma.jobArtifact.create({
        data: {
          jobId: job.id,
          type: 'original',
          storagePath: files[i].storagePath,
          mimeType: files[i].mimeType,
          sizeBytes: BigInt(files[i].actualSize),
        },
      });
    }

    // Enqueue
    await enqueueJob(job.id);
    await prisma.job.update({ where: { id: job.id }, data: { status: 'queued' } });

    return NextResponse.json({
      id: job.id, status: 'queued', fileName: allFileNames, fileSize: totalSize, fileCount: files.length,
    });
  } catch (err) {
    console.error('Upload complete error:', err);
    return NextResponse.json({ error: 'Failed to complete upload' }, { status: 500 });
  }
}
