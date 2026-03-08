import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/client';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const job = await prisma.job.findUnique({
      where: { id: params.id },
      include: {
        artifacts: {
          orderBy: { createdAt: 'asc' },
        },
        segments: {
          orderBy: { segmentIndex: 'asc' },
          take: 500,
        },
        logs: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Serialize BigInt values
    const serialized = {
      ...job,
      originalFileSize: job.originalFileSize.toString(),
      artifacts: job.artifacts.map((a: { sizeBytes: bigint;[key: string]: unknown }) => ({
        ...a,
        sizeBytes: a.sizeBytes.toString(),
      })),
    };

    return NextResponse.json(serialized);
  } catch (err) {
    console.error('Job detail error:', err);
    return NextResponse.json({ error: 'Failed to fetch job' }, { status: 500 });
  }
}
