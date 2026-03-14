import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../lib/db/client';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check if client wants the light version (for polling during processing)
    const light = request.nextUrl.searchParams.get('light') === '1';

    const job = await prisma.job.findUnique({
      where: { id: params.id },
      include: {
        artifacts: { orderBy: { createdAt: 'asc' } },
        // Only load segments when job is done and not in light mode
        segments: light ? false : { orderBy: { segmentIndex: 'asc' } },
        logs: light ? false : { orderBy: { createdAt: 'asc' } },
        timings: { orderBy: { startedAt: 'asc' } },
        reportVersions: light ? false : { orderBy: { version: 'desc' }, select: { id: true, reportType: true, label: true, version: true, createdAt: true } },
      },
    });

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const serialized = {
      ...job,
      originalFileSize: job.originalFileSize.toString(),
      artifacts: job.artifacts.map((a: { sizeBytes: bigint;[key: string]: unknown }) => ({
        ...a,
        sizeBytes: a.sizeBytes.toString(),
      })),
      // Ensure arrays exist even in light mode
      segments: (job as Record<string, unknown>).segments || [],
      logs: (job as Record<string, unknown>).logs || [],
      reportVersions: (job as Record<string, unknown>).reportVersions || [],
    };

    return NextResponse.json(serialized);
  } catch (err) {
    console.error('Job detail error:', err);
    return NextResponse.json({ error: 'Failed to fetch job' }, { status: 500 });
  }
}
