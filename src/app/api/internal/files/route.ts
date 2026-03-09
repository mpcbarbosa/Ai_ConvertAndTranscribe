import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '../../../../lib/storage';

/**
 * Internal endpoint for worker to upload artifacts to web service storage.
 */
export async function PUT(request: NextRequest) {
  try {
    const key = request.headers.get('x-storage-key');
    if (!key) {
      return NextResponse.json({ error: 'Missing x-storage-key header' }, { status: 400 });
    }

    const data = Buffer.from(await request.arrayBuffer());
    const storage = getStorage();
    await storage.save(key, data);

    return NextResponse.json({ ok: true, key, size: data.length });
  } catch (err) {
    console.error('Internal file upload error:', err);
    return NextResponse.json({ error: 'Failed to save file' }, { status: 500 });
  }
}
