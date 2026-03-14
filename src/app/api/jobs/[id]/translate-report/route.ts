import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/db/client';
import OpenAI from 'openai';

export const maxDuration = 120;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LANG_NAMES: Record<string, string> = {
  en: 'English', pt: 'Portuguese', es: 'Spanish', fr: 'French',
  de: 'German', it: 'Italian', nl: 'Dutch', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
};

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const job = await prisma.job.findUnique({
      where: { id: params.id },
      select: { meetingReport: true, technicalReport: true, processingMode: true },
    });
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const { targetLanguage, reportType } = await request.json();
    if (!targetLanguage) return NextResponse.json({ error: 'Missing targetLanguage' }, { status: 400 });

    const reportField = reportType === 'technical' ? 'technicalReport' : 'meetingReport';
    const currentReport = reportType === 'technical' ? job.technicalReport : job.meetingReport;
    if (!currentReport) return NextResponse.json({ error: 'No report to translate' }, { status: 400 });

    const langName = LANG_NAMES[targetLanguage] || targetLanguage;
    const model = job.processingMode === 'best_quality' ? 'gpt-4o' : 'gpt-4o-mini';

    const response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. Translate the following document to ${langName}. Preserve ALL formatting (markdown headers, bullet points, tables, bold text, etc.) exactly as they are. Translate the content accurately while maintaining professional tone and domain-specific terminology. Do NOT add, remove, or summarize any content — translate everything.`,
        },
        { role: 'user', content: currentReport },
      ],
    });

    const translated = response.choices[0]?.message?.content;
    if (!translated) return NextResponse.json({ error: 'Translation failed' }, { status: 500 });

    // Get next version number
    const lastVersion = await prisma.reportVersion.findFirst({
      where: { jobId: params.id, reportType: reportType || 'meeting' },
      orderBy: { version: 'desc' },
    });
    const newVersion = (lastVersion?.version || 0) + 1;

    // Save as new version
    await prisma.reportVersion.create({
      data: {
        jobId: params.id,
        reportType: reportType || 'meeting',
        content: translated,
        label: `Translation → ${langName}`,
        version: newVersion,
      },
    });

    // Update current report
    await prisma.job.update({
      where: { id: params.id },
      data: { [reportField]: translated },
    });

    return NextResponse.json({ report: translated, version: newVersion, language: langName });
  } catch (err) {
    console.error('Translate report error:', err);
    return NextResponse.json({ error: 'Failed to translate report' }, { status: 500 });
  }
}
