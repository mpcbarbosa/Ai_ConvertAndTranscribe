import { NextResponse } from 'next/server';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET_NAME || 'aiconverttranscribe';

    if (!accountId || !accessKeyId || !secretAccessKey) {
      return NextResponse.json({ error: 'R2 not configured' }, { status: 400 });
    }

    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });

    // List all objects
    const objects: Array<{ key: string; size: number; modified: string }> = [];
    let continuationToken: string | undefined;
    let totalSize = 0;

    do {
      const res = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }));

      for (const obj of res.Contents || []) {
        objects.push({
          key: obj.Key || '',
          size: obj.Size || 0,
          modified: obj.LastModified?.toISOString() || '',
        });
        totalSize += obj.Size || 0;
      }

      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    // Group by prefix
    const byPrefix: Record<string, { count: number; sizeMB: number }> = {};
    for (const obj of objects) {
      const prefix = obj.key.split('/')[0] || 'root';
      if (!byPrefix[prefix]) byPrefix[prefix] = { count: 0, sizeMB: 0 };
      byPrefix[prefix].count++;
      byPrefix[prefix].sizeMB += obj.size / 1024 / 1024;
    }

    // Round sizes
    for (const k of Object.keys(byPrefix)) {
      byPrefix[k].sizeMB = Math.round(byPrefix[k].sizeMB * 10) / 10;
    }

    return NextResponse.json({
      bucket,
      totalFiles: objects.length,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 10) / 10,
      byPrefix,
      files: objects.map(o => ({
        key: o.key,
        sizeMB: Math.round(o.size / 1024 / 1024 * 100) / 100,
        modified: o.modified,
      })),
    });
  } catch (err) {
    console.error('R2 status error:', err);
    return NextResponse.json({ error: 'Failed to list R2 objects' }, { status: 500 });
  }
}
