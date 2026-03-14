import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/db/client';
import { enqueueJob } from '../../../../../lib/queue';
import { getStorage } from '../../../../../lib/storage';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const job = await prisma.job.findUnique({
      where: { id: params.id },
      include: { artifacts: true },
    });

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status !== 'failed' && job.status !== 'completed') {
      return NextResponse.json(
        { error: 'Can only retry failed or completed jobs' },
        { status: 400 }
      );
    }

    // Delete non-original artifact files from storage (R2 or local)
    const storage = getStorage();
    const nonOriginals = job.artifacts.filter(a => a.type !== 'original');
    for (const artifact of nonOriginals) {
      try { await storage.delete(artifact.storagePath); } catch { /* ignore */ }
    }

    // Clean up old segments, logs, timings, report versions, and non-original artifacts
    await prisma.transcriptSegment.deleteMany({ where: { jobId: job.id } });
    await prisma.processingLog.deleteMany({ where: { jobId: job.id } });
    await prisma.stageTiming.deleteMany({ where: { jobId: job.id } });
    await prisma.reportVersion.deleteMany({ where: { jobId: job.id } });
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
        meetingReport: null,
        technicalReport: null,
        progress: 0,
        currentStage: null,
        cancelRequested: false,
      },
    });

    await enqueueJob(job.id);

    return NextResponse.json({ status: 'queued' });
  } catch (err) {
    console.error('Retry error:', err);
    return NextResponse.json({ error: 'Failed to retry job' }, { status: 500 });
  }
}
