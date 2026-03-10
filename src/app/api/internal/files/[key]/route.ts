import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '../../../../../lib/storage';
import { createReadStream, statSync, existsSync } from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Internal endpoint for worker to download files from web service storage.
 * Uses streaming to avoid loading large files into memory.
 * Supports Range requests for chunked downloading.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { key: string } }
) {
  try {
    const key = decodeURIComponent(params.key);
    const storage = getStorage();
    const filePath = storage.getLocalPath(key);

    console.log(`[internal/files] Serving file: ${key}`);
    console.log(`[internal/files] Resolved path: ${filePath}`);
    console.log(`[internal/files] File exists: ${existsSync(filePath)}`);

    if (!existsSync(filePath)) {
      console.error(`[internal/files] File not found: ${filePath}`);
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const stat = statSync(filePath);
    const fileSize = stat.size;
    console.log(`[internal/files] File size: ${fileSize} bytes`);

    const range = request.headers.get('range');

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = match[2] ? parseInt(match[2]) : Math.min(start + 40 * 1024 * 1024 - 1, fileSize - 1);
        const chunkSize = end - start + 1;

        console.log(`[internal/files] Range request: ${start}-${end} (${chunkSize} bytes)`);

        const stream = createReadStream(filePath, { start, end });
        const webStream = new ReadableStream({
          start(controller) {
            stream.on('data', (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            stream.on('end', () => controller.close());
            stream.on('error', (err) => controller.error(err));
          },
          cancel() {
            stream.destroy();
          },
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

    // No Range header — stream entire file (never loads into memory)
    console.log(`[internal/files] Full file stream (no range)`);

    const stream = createReadStream(filePath);
    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
      cancel() {
        stream.destroy();
      },
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
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
