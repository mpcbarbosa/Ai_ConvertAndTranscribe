import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/db/client';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const job = await prisma.job.findUnique({ where: { id: params.id } });
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const activeStatuses = ['queued', 'converting', 'transcribing', 'post_processing', 'translating', 'generating_report', 'generating_outputs'];
    if (!activeStatuses.includes(job.status)) {
      return NextResponse.json({ error: 'Job is not currently processing' }, { status: 400 });
    }

    await prisma.job.update({
      where: { id: params.id },
      data: { cancelRequested: true },
    });

    return NextResponse.json({ status: 'cancel_requested' });
  } catch (err) {
    console.error('Cancel error:', err);
    return NextResponse.json({ error: 'Failed to cancel job' }, { status: 500 });
  }
}
