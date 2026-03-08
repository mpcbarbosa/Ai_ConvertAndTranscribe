import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../../lib/db/client';
import { getStorage } from '../../../../../../lib/storage';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string; artifactId: string } }
) {
  try {
    const artifact = await prisma.jobArtifact.findFirst({
      where: {
        id: params.artifactId,
        jobId: params.id,
      },
    });

    if (!artifact) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }

    const storage = getStorage();
    const data = await storage.read(artifact.storagePath);

    // Determine filename
    const job = await prisma.job.findUnique({ where: { id: params.id } });
    const baseName = job?.originalFileName?.replace(/\.[^.]+$/, '') || 'output';

    const fileNameMap: Record<string, string> = {
      original: job?.originalFileName || 'original',
      mp3: `${baseName}.mp3`,
      transcript_txt: `${baseName}_transcript.txt`,
      transcript_json: `${baseName}_transcript.json`,
      translation_txt: `${baseName}_translation.txt`,
      translation_json: `${baseName}_translation.json`,
      srt: `${baseName}.srt`,
      vtt: `${baseName}.vtt`,
    };

    const fileName = fileNameMap[artifact.type] || 'download';

    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': artifact.mimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': data.length.toString(),
      },
    });
  } catch (err) {
    console.error('Download error:', err);
    return NextResponse.json({ error: 'Failed to download artifact' }, { status: 500 });
  }
}
