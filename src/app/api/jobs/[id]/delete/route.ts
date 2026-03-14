import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/db/client';
import { getStorage } from '../../../../../lib/storage';

/**
 * Delete a job and all associated R2/local storage files.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const job = await prisma.job.findUnique({
      where: { id: params.id },
      include: { artifacts: true },
    });
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const storage = getStorage();

    // Delete all artifact files from storage (R2 or local)
    for (const artifact of job.artifacts) {
      try {
        await storage.delete(artifact.storagePath);
        console.log(`[delete] Deleted: ${artifact.storagePath}`);
      } catch (err) {
        console.warn(`[delete] Failed to delete ${artifact.storagePath}:`, err);
      }
    }

    // Delete the job (cascades to artifacts, segments, logs, timings, reportVersions)
    await prisma.job.delete({ where: { id: params.id } });

    return NextResponse.json({ ok: true, deletedArtifacts: job.artifacts.length });
  } catch (err) {
    console.error('Delete job error:', err);
    return NextResponse.json({ error: 'Failed to delete job' }, { status: 500 });
  }
}
