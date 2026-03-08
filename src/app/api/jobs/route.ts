import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../lib/db/client';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const search = searchParams.get('search');
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');

    const where: Record<string, unknown> = {};

    if (status && status !== 'all') {
      if (status === 'processing') {
        where.status = {
          in: ['queued', 'converting', 'transcribing', 'post_processing', 'translating', 'generating_outputs'],
        };
      } else {
        where.status = status;
      }
    }

    if (search) {
      where.originalFileName = { contains: search, mode: 'insensitive' };
    }

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          originalFileName: true,
          originalFileSize: true,
          sourceType: true,
          sourceLanguage: true,
          detectedLanguage: true,
          targetLanguage: true,
          processingMode: true,
          status: true,
          durationSeconds: true,
          createdAt: true,
          completedAt: true,
          errorMessage: true,
        },
      }),
      prisma.job.count({ where: where as never }),
    ]);

    // Convert BigInt to string for serialization
    const serialized = jobs.map((j: { originalFileSize: bigint;[key: string]: unknown }) => ({
      ...j,
      originalFileSize: j.originalFileSize.toString(),
    }));

    return NextResponse.json({ jobs: serialized, total });
  } catch (err) {
    console.error('Jobs list error:', err);
    return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 });
  }
}
