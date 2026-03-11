import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '../../../../../lib/storage';
import { createReadStream, statSync, existsSync } from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Download endpoint using query param for storage key.
 * Usage: GET /api/internal/files/download?key=uploads/uuid/filename.mp4
 * Supports Range requests for chunked downloading.
 */
export async function GET(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get('key');
    if (!key) {
      return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
    }

    const storage = getStorage();
    const filePath = storage.getLocalPath(key);

    console.log(`[files/download] Key: ${key}, Path: ${filePath}, Exists: ${existsSync(filePath)}`);

    if (!existsSync(filePath)) {
      return NextResponse.json({ error: 'File not found', key }, { status: 404 });
    }

    const stat = statSync(filePath);
    const fileSize = stat.size;
    console.log(`[files/download] Size: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

    const range = request.headers.get('range');

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = match[2] ? parseInt(match[2]) : Math.min(start + 10 * 1024 * 1024 - 1, fileSize - 1);
        const chunkSize = end - start + 1;

        console.log(`[files/download] Range: ${start}-${end} (${(chunkSize / 1024 / 1024).toFixed(1)} MB)`);

        const stream = createReadStream(filePath, { start, end });
        const webStream = new ReadableStream({
          start(controller) {
            stream.on('data', (c: string | Buffer) => controller.enqueue(new Uint8Array(typeof c === 'string' ? Buffer.from(c) : c)));
            stream.on('end', () => controller.close());
            stream.on('error', (e) => controller.error(e));
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

    // No range — stream full file
    const stream = createReadStream(filePath);
    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (c: string | Buffer) => controller.enqueue(new Uint8Array(typeof c === 'string' ? Buffer.from(c) : c)));
        stream.on('end', () => controller.close());
        stream.on('error', (e) => controller.error(e));
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
    console.error('[files/download] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
