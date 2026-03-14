import { NextRequest, NextResponse } from 'next/server';
import { getStorage, isR2Storage } from '../../../../../lib/storage';
import { createReadStream, statSync, existsSync } from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Download endpoint. Serves from R2 or local disk.
 * Supports Range requests for chunked downloading.
 */
export async function GET(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get('key');
    if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 });

    const storage = getStorage();

    if (isR2Storage()) {
      // R2 mode: get size, then serve range or full
      const fileSize = await storage.getSize(key);
      if (fileSize === 0) return NextResponse.json({ error: 'File not found' }, { status: 404 });

      const range = request.headers.get('range');
      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1]);
          const rawEnd = match[2] ? parseInt(match[2]) : start + 10 * 1024 * 1024 - 1;
          const end = Math.min(rawEnd, fileSize - 1);
          const chunkSize = end - start + 1;

          // Use R2 readRange
          const { R2StorageProvider } = require('../../../../../lib/storage/r2');
          const r2 = storage as InstanceType<typeof R2StorageProvider>;
          const data = await r2.readRange(key, start, end);

          return new NextResponse(new Uint8Array(data), {
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

      // Full file from R2
      const data = await storage.read(key);
      return new NextResponse(new Uint8Array(data), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize.toString(),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    // Local disk mode
    const filePath = storage.getLocalPath(key);
    if (!existsSync(filePath)) return NextResponse.json({ error: 'File not found' }, { status: 404 });

    const stat = statSync(filePath);
    const fileSize = stat.size;
    const range = request.headers.get('range');

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        const rawEnd = match[2] ? parseInt(match[2]) : start + 10 * 1024 * 1024 - 1;
        const end = Math.min(rawEnd, fileSize - 1);
        const chunkSize = end - start + 1;

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
