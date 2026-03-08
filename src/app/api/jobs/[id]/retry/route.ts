import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/db/client';
import { enqueueJob } from '../../../../../lib/queue';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const job = await prisma.job.findUnique({ where: { id: params.id } });

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status !== 'failed' && job.status !== 'completed') {
      return NextResponse.json(
        { error: 'Can only retry failed or completed jobs' },
        { status: 400 }
      );
    }

    // Clean up old segments and non-original artifacts
    await prisma.transcriptSegment.deleteMany({ where: { jobId: job.id } });
    await prisma.processingLog.deleteMany({ where: { jobId: job.id } });
    await prisma.jobArtifact.deleteMany({
      where: { jobId: job.id, type: { not: 'original' } },
    });

    // Reset job status
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'queued',
        errorMessage: null,
        completedAt: null,
        detectedLanguage: null,
        providerUsed: null,
      },
    });

    // Re-enqueue
    await enqueueJob(job.id);

    return NextResponse.json({ status: 'queued' });
  } catch (err) {
    console.error('Retry error:', err);
    return NextResponse.json({ error: 'Failed to retry job' }, { status: 500 });
  }
}
