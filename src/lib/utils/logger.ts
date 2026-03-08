import prisma from '../db/client';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export async function logProcessing(
  jobId: string,
  stage: string,
  level: LogLevel,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${jobId}] [${stage}]`;
  console.log(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');

  try {
    await prisma.processingLog.create({
      data: {
        jobId,
        stage,
        level,
        message,
        metadata: metadata || undefined,
      },
    });
  } catch {
    console.error(`Failed to persist log for job ${jobId}`);
  }
}

export function createJobLogger(jobId: string) {
  return {
    info: (stage: string, message: string, metadata?: Record<string, unknown>) =>
      logProcessing(jobId, stage, 'info', message, metadata),
    warn: (stage: string, message: string, metadata?: Record<string, unknown>) =>
      logProcessing(jobId, stage, 'warn', message, metadata),
    error: (stage: string, message: string, metadata?: Record<string, unknown>) =>
      logProcessing(jobId, stage, 'error', message, metadata),
    debug: (stage: string, message: string, metadata?: Record<string, unknown>) =>
      logProcessing(jobId, stage, 'debug', message, metadata),
  };
}
