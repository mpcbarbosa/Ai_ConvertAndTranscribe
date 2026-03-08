import { Queue, Worker, type Job as BullJob } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return connection;
}

export const QUEUE_NAME = 'transcription-jobs';

let queue: Queue | null = null;

export function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return queue;
}

export interface TranscriptionJobData {
  jobId: string;
}

export async function enqueueJob(jobId: string): Promise<void> {
  const q = getQueue();
  await q.add('transcribe', { jobId } satisfies TranscriptionJobData, {
    jobId: jobId,
  });
}

export { Worker, type BullJob };
