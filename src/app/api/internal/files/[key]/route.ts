import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '../../../../../lib/storage';
import { createReadStream, statSync, existsSync } from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Internal endpoint for worker to download files.
 * Key can come from URL param OR query param (?key=...) for paths with slashes.
 * Supports Range requests for chunked download of large files.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { key: string } }
) {
  try {
    // Support key from query param (safer for paths with slashes)
    const queryKey = request.nextUrl.searchParams.get('key');
    const key = queryKey || decodeURIComponent(params.key);

    const storage = getStorage();
    const filePath = storage.getLocalPath(key);

    console.log(`[internal/files] Key: ${key}`);
    console.log(`[internal/files] Path: ${filePath}`);
    console.log(`[internal/files] Exists: ${existsSync(filePath)}`);

    if (!existsSync(filePath)) {
      console.error(`[internal/files] NOT FOUND: ${filePath}`);
      return NextResponse.json({ error: 'File not found', key, filePath }, { status: 404 });
    }

    const stat = statSync(filePath);
    const fileSize = stat.size;
    console.log(`[internal/files] Size: ${fileSize}`);

    const range = request.headers.get('range');

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = match[2] ? parseInt(match[2]) : Math.min(start + 10 * 1024 * 1024 - 1, fileSize - 1);
        const chunkSize = end - start + 1;

        const stream = createReadStream(filePath, { start, end });
        const webStream = new ReadableStream({
          start(controller) {
            stream.on('data', (chunk: string | Buffer) => controller.enqueue(new Uint8Array(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)));
            stream.on('end', () => controller.close());
            stream.on('error', (err) => controller.error(err));
          },
          cancel() { stream.destroy(); },
        });

        return new NextResponse(webStream, {
          status: 206,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunkSize.toString(),
            'Accept-Ranges': 'bytes',
          },
        });
      }
    }

    // Stream full file
    const stream = createReadStream(filePath);
    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk: string | Buffer) => controller.enqueue(new Uint8Array(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
      cancel() { stream.destroy(); },
    });

    return new NextResponse(webStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize.toString(),
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (err) {
    console.error('[internal/files] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
