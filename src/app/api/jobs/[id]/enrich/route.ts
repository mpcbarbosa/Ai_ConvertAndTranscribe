import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../../lib/db/client';
import OpenAI from 'openai';

export const maxDuration = 120;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const job = await prisma.job.findUnique({
      where: { id: params.id },
      select: { meetingReport: true, detectedLanguage: true, sourceLanguage: true },
    });

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (!job.meetingReport) return NextResponse.json({ error: 'No report to enrich' }, { status: 400 });

    const body = await request.json();
    const { instruction, context } = body;

    if (!instruction) {
      return NextResponse.json({ error: 'Missing instruction' }, { status: 400 });
    }

    const lang = job.detectedLanguage || job.sourceLanguage || 'en';
    const langNames: Record<string, string> = { pt: 'Portuguese', en: 'English', es: 'Spanish', fr: 'French' };
    const langName = langNames[lang] || 'English';

    // Get transcript segments for context
    const segments = await prisma.transcriptSegment.findMany({
      where: { jobId: params.id },
      orderBy: { segmentIndex: 'asc' },
      select: { sourceText: true },
      take: 800,
    });
    const transcript = segments.map(s => s.sourceText).join(' ');

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 4000,
      messages: [
        {
          role: 'system',
          content: `You are a senior business and technical analyst specializing in meeting analysis and reporting. You write in ${langName}.

You have access to the full meeting transcript and the current meeting report. Your role is to enrich, expand, and improve the report based on the user's instructions.

${context ? `DOMAIN CONTEXT: The user has specified this domain/context for the meeting: "${context}". You should act as an expert in this domain, using appropriate technical terminology, frameworks, and best practices from this field.` : ''}

Guidelines:
- Write professionally with technical depth appropriate to the domain
- Use specific terminology from the relevant industry/technology
- Reference specific points from the transcript to support your analysis
- Add actionable insights and expert recommendations
- Maintain structured formatting with clear sections
- If you add technical analysis, explain concepts clearly
- Preserve all existing accurate information from the current report
- Write the COMPLETE updated report, not just the new sections
- Always write in ${langName}`,
        },
        {
          role: 'user',
          content: `CURRENT REPORT:\n${job.meetingReport}\n\nMEETING TRANSCRIPT (for reference):\n${transcript.substring(0, 12000)}\n\nINSTRUCTION: ${instruction}`,
        },
      ],
    });

    const enrichedReport = response.choices[0]?.message?.content;
    if (!enrichedReport) {
      return NextResponse.json({ error: 'Failed to generate enriched report' }, { status: 500 });
    }

    // Save the enriched report
    await prisma.job.update({
      where: { id: params.id },
      data: { meetingReport: enrichedReport },
    });

    return NextResponse.json({ report: enrichedReport });
  } catch (err) {
    console.error('Enrich error:', err);
    return NextResponse.json({ error: 'Failed to enrich report' }, { status: 500 });
  }
}
