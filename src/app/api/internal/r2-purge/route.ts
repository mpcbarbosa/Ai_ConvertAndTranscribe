import { NextResponse } from 'next/server';
import prisma from '../../../../lib/db/client';
import { getStorage } from '../../../../lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Purge orphaned R2 files that are not referenced by any job artifact.
 * Also cleans up leftover upload chunks.
 */
export async function POST() {
  try {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    
    if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_ACCOUNT_ID) {
      return NextResponse.json({ error: 'R2 not configured' }, { status: 400 });
    }

    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    });

    const bucket = process.env.R2_BUCKET_NAME || 'aiconverttranscribe';

    // List all R2 objects
    const allKeys: string[] = [];
    let token: string | undefined;
    do {
      const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      for (const obj of res.Contents || []) if (obj.Key) allKeys.push(obj.Key);
      token = res.NextContinuationToken;
    } while (token);

    // Get all artifact storage paths from DB
    const artifacts = await prisma.jobArtifact.findMany({ select: { storagePath: true } });
    const validPaths = new Set(artifacts.map(a => a.storagePath));

    // Find orphans: R2 keys not in any artifact
    const storage = getStorage();
    const orphans: string[] = [];
    for (const key of allKeys) {
      // Chunks are always orphans (should be cleaned after assembly)
      if (key.startsWith('chunks/')) {
        orphans.push(key);
        continue;
      }
      // Check if this key is referenced by any artifact
      if (!validPaths.has(key)) {
        orphans.push(key);
      }
    }

    // Delete orphans
    let deletedCount = 0;
    let deletedBytes = 0;
    for (const key of orphans) {
      try {
        await storage.delete(key);
        deletedCount++;
      } catch { /* ignore */ }
    }

    return NextResponse.json({
      totalR2Files: allKeys.length,
      validArtifacts: validPaths.size,
      orphansFound: orphans.length,
      orphansDeleted: deletedCount,
      orphanKeys: orphans,
    });
  } catch (err) {
    console.error('R2 purge error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
