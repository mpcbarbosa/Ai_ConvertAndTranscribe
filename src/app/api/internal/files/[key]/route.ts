import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '../../../../../lib/storage';

/**
 * Internal endpoint for worker to download files from web service storage.
 * The worker cannot access the web service's disk directly on Render,
 * so it fetches files via this HTTP endpoint.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { key: string } }
) {
  try {
    const key = decodeURIComponent(params.key);
    const storage = getStorage();

    if (!(await storage.exists(key))) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const data = await storage.read(key);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length.toString(),
      },
    });
  } catch (err) {
    console.error('Internal file serve error:', err);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
