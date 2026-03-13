import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/db/client';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const versions = await prisma.reportVersion.findMany({
      where: { jobId: params.id },
      orderBy: { version: 'desc' },
      select: { id: true, reportType: true, label: true, version: true, createdAt: true },
    });
    return NextResponse.json(versions);
  } catch (err) {
    console.error('Report versions error:', err);
    return NextResponse.json({ error: 'Failed to fetch versions' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { versionId, reportType } = await request.json();

    const version = await prisma.reportVersion.findUnique({ where: { id: versionId } });
    if (!version || version.jobId !== params.id) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }

    // Restore this version as current
    const field = reportType === 'technical' ? 'technicalReport' : 'meetingReport';
    await prisma.job.update({
      where: { id: params.id },
      data: { [field]: version.content },
    });

    return NextResponse.json({ restored: true, version: version.version });
  } catch (err) {
    console.error('Restore version error:', err);
    return NextResponse.json({ error: 'Failed to restore version' }, { status: 500 });
  }
}
