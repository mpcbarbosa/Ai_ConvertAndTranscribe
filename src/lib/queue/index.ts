import { Queue, Worker, type Job as BullJob } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function getConnectionConfig() {
  const url = new URL(REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379'),
    password: url.password || undefined,
    username: url.username || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null as null,
    enableReadyCheck: false,
  };
}

export const QUEUE_NAME = 'transcription-jobs';

let queue: Queue | null = null;

export function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: getConnectionConfig(),
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

export function getWorkerConnection() {
  return getConnectionConfig();
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

export { Queue, Worker, type BullJob };
