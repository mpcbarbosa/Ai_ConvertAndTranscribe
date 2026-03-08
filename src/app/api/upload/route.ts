import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/client';
import { getStorage } from '@/lib/storage';
import { enqueueJob } from '@/lib/queue';
import { sanitizeFileName, isVideoFile, getFileExtension } from '@/lib/utils';
import { SUPPORTED_EXTENSIONS } from '@/types';
import { v4 as uuidv4 } from 'uuid';

const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '500') * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const sourceLanguage = formData.get('sourceLanguage') as string | null;
    const targetLanguage = formData.get('targetLanguage') as string | null;
    const processingMode = formData.get('processingMode') as string || 'balanced';
    const uiLanguage = formData.get('uiLanguage') as string || 'en';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file size
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size: ${process.env.MAX_UPLOAD_SIZE_MB || 500}MB` },
        { status: 400 }
      );
    }

    // Validate file extension
    const ext = getFileExtension(file.name);
    if (!SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])) {
      return NextResponse.json(
        { error: `Unsupported file type: ${ext}` },
        { status: 400 }
      );
    }

    // Validate MIME type loosely (browsers can be inconsistent)
    const mimeType = file.type || 'application/octet-stream';

    const isVideo = isVideoFile(mimeType) || ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext);
    const sourceType = isVideo ? 'video' : 'audio';

    // Generate storage key and save file
    const storage = getStorage();
    const safeFileName = sanitizeFileName(file.name);
    const storageKey = `uploads/${uuidv4()}/${safeFileName}`;

    const buffer = Buffer.from(await file.arrayBuffer());
    await storage.save(storageKey, buffer);

    // Create job in database
    const job = await prisma.job.create({
      data: {
        originalFileName: file.name,
        originalMimeType: mimeType,
        originalFileSize: BigInt(file.size),
        sourceType: sourceType as 'video' | 'audio',
        sourceLanguage: sourceLanguage || null,
        targetLanguage: targetLanguage || null,
        uiLanguage,
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
        mimeType,
        sizeBytes: BigInt(file.size),
      },
    });

    // Enqueue for processing
    await enqueueJob(job.id);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'queued' },
    });

    return NextResponse.json({
      id: job.id,
      status: 'queued',
      fileName: file.name,
    });
  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json(
      { error: 'Failed to process upload' },
      { status: 500 }
    );
  }
}
