import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '../../../../../lib/storage';
import fs from 'fs';
import path from 'path';

/**
 * Internal endpoint for worker to download files.
 * Supports Range requests for chunked downloading of large files.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { key: string } }
) {
  try {
    const key = decodeURIComponent(params.key);
    const storage = getStorage();

    if (!(await storage.exists(key))) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const filePath = storage.getLocalPath(key);
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // Check for Range header (chunked download)
    const range = request.headers.get('range');

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1]);
        const end = match[2] ? parseInt(match[2]) : Math.min(start + 50 * 1024 * 1024 - 1, fileSize - 1); // 50MB chunks
        const chunkSize = end - start + 1;

        const stream = fs.createReadStream(filePath, { start, end });
        const readable = new ReadableStream({
          start(controller) {
            stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            stream.on('end', () => controller.close());
            stream.on('error', (err) => controller.error(err));
          },
        });

        return new NextResponse(readable, {
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

    // For small files (<50MB), return directly
    if (fileSize < 50 * 1024 * 1024) {
      const data = fs.readFileSync(filePath);
      return new NextResponse(new Uint8Array(data), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize.toString(),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    // For large files without Range header, stream the whole file
    const stream = fs.createReadStream(filePath);
    const readable = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
    });

    return new NextResponse(readable, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize.toString(),
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (err) {
    console.error('Internal file serve error:', err);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
