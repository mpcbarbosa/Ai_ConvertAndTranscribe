# TranscribeX

Production-grade video & audio transcription web application with multilingual support. Upload video or audio files to get high-quality transcriptions, translations, and subtitle exports.

## Features

- **Video/Audio Upload** — MP4, MOV, MKV, WebM, AVI, MP3, WAV, M4A, OGG
- **FFmpeg Processing** — Audio extraction, normalization, chunking for large files
- **AI Transcription** — OpenAI Whisper with quality modes (Best Quality / Balanced)
- **Translation** — Translate between English, Portuguese, Spanish, and French
- **Subtitle Export** — SRT and VTT formats
- **Full i18n** — UI available in EN, PT, ES, FR with language switcher
- **Background Processing** — BullMQ + Redis for async job execution
- **Job Management** — Status tracking, retry, artifact downloads
- **Production Architecture** — PostgreSQL, Prisma, abstracted storage layer

## Tech Stack

- **Frontend**: Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Backend**: Next.js API routes, Prisma ORM, PostgreSQL
- **Queue**: BullMQ + Redis
- **Media**: FFmpeg
- **AI**: OpenAI (Whisper for transcription, GPT-4o-mini for post-processing & translation)
- **Deployment**: Render-ready with render.yaml

## Prerequisites

- Node.js 18+
- PostgreSQL
- Redis
- FFmpeg (installed and in PATH)
- OpenAI API key

## Local Development Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd transcribex
npm install
```

### 2. Environment variables

```bash
cp .env.example .env
# Edit .env with your actual values:
# - DATABASE_URL (PostgreSQL connection string)
# - REDIS_URL (Redis connection string)
# - OPENAI_API_KEY
```

### 3. Database setup

```bash
npx prisma migrate dev
```

### 4. Start development

In separate terminals:

```bash
# Terminal 1: Web server
npm run dev

# Terminal 2: Worker
npm run worker:dev
```

The app will be available at `http://localhost:3000`

## Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── api/               # API routes (upload, jobs, artifacts, health)
│   └── [locale]/          # Locale-prefixed pages (en, pt, es, fr)
│       ├── upload/        # Upload page
│       ├── jobs/          # Jobs list
│       └── jobs/[id]/     # Job detail
├── components/            # React components
│   ├── layout/           # Header, navigation
│   ├── upload/           # Upload form with drag-and-drop
│   └── jobs/             # Job list and detail views
├── lib/                   # Core libraries
│   ├── db/               # Prisma client
│   ├── i18n/             # Internationalization
│   ├── media/            # FFmpeg pipeline, artifact generation
│   ├── queue/            # BullMQ queue setup
│   ├── storage/          # Storage abstraction (local/S3)
│   ├── transcription/    # Whisper provider, post-processing
│   ├── translation/      # GPT translation provider
│   └── utils/            # Helpers, logger
├── locales/              # Translation dictionaries
│   ├── en/common.json
│   ├── pt/common.json
│   ├── es/common.json
│   └── fr/common.json
├── types/                # Shared TypeScript types
├── worker/               # Background job processor
└── middleware.ts          # Locale routing middleware
```

## Processing Pipeline

1. User uploads file → validated and stored
2. Job created in PostgreSQL → queued in Redis
3. Worker picks up job:
   - Extract audio / convert to MP3 (FFmpeg)
   - Normalize audio (16kHz mono, loudnorm)
   - Split into chunks if >10min (with overlap)
   - Transcribe each chunk (Whisper API)
   - Merge chunks (deduplicate overlaps)
   - Post-process transcript (GPT cleanup for best quality)
   - Translate if target language selected (GPT)
   - Generate artifacts (TXT, JSON, SRT, VTT)
4. Artifacts available for download in UI

## Quality Modes

| Feature | Best Quality | Balanced |
|---------|-------------|----------|
| Chunk size | 8 min | 10 min |
| Overlap | 20s | 10s |
| Post-processing | GPT-4o-mini cleanup | Local cleanup |
| Whisper prompt | Detailed accuracy hints | Standard |
| Cost | Higher | Lower |

## Deployment to Render

### Using render.yaml (recommended)

1. Push code to GitHub
2. In Render dashboard → **New** → **Blueprint**
3. Connect your GitHub repo
4. Render will create all services from `render.yaml`
5. Set `OPENAI_API_KEY` in the Render dashboard for both web and worker services

### Manual setup

Create these services in Render:

1. **PostgreSQL** — Starter plan
2. **Redis** — Starter plan
3. **Web Service** — Node runtime
   - Build: `npm install && npx prisma generate && npx prisma migrate deploy && npm run build`
   - Start: `npm start`
   - Health check: `/api/health`
4. **Worker Service** — Node runtime
   - Build: `npm install && npx prisma generate`
   - Start: `npx tsx src/worker/index.ts`

### Environment Variables (Render)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (auto from Render) |
| `REDIS_URL` | Redis connection string (auto from Render) |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `STORAGE_PROVIDER` | `local` (use persistent disk) |
| `STORAGE_LOCAL_PATH` | `/opt/render/project/storage` |
| `MAX_UPLOAD_SIZE_MB` | `500` |
| `NODE_ENV` | `production` |

### Storage Notes

- MVP uses local persistent disk on Render
- Storage is behind an abstraction layer (`src/lib/storage/`)
- To migrate to S3/R2: implement `S3StorageProvider` in the storage module
- Both web and worker need access to the same storage (shared disk or object storage)

## Adding a New Language

### For UI translation:

1. Create `src/locales/{code}/common.json` (copy from `en/common.json`)
2. Translate all strings
3. Add the locale code to `SUPPORTED_LOCALES` in `src/types/index.ts`
4. Add the locale to `src/middleware.ts` locales array
5. Add display name to `LOCALE_LABELS` in `src/components/layout/header.tsx`

### For transcription/translation language support:

1. Add language mapping in `src/lib/translation/index.ts` `LANGUAGE_MAP`
2. Add language options in upload form selects

## Known Limitations

- **Storage**: Web and worker share storage via persistent disk. For multi-instance scaling, migrate to object storage (S3/R2).
- **Concurrency**: Worker processes 1 job at a time. Scale by adding more worker instances.
- **File size**: Limited by Render disk and OpenAI's 25MB per-chunk limit for Whisper. Chunking handles this automatically.
- **Diarization**: Speaker identification is not implemented in MVP. Whisper doesn't natively support it.
- **Auth**: No authentication in MVP. Add NextAuth.js or similar for production multi-user support.

## License

Private — All rights reserved.
