/**
 * Browser-side audio extraction using FFmpeg.wasm loaded from CDN.
 * Converts video files to small MP3 audio files before upload.
 * 467MB video → ~45MB audio = 10x smaller upload.
 */

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || 
    /\.(mp4|mov|mkv|webm|avi|m4v|flv|wmv)$/i.test(file.name);
}

let ffmpegReady = false;
let ffmpegInstance: any = null;

async function loadFFmpegFromCDN(): Promise<any> {
  if (ffmpegInstance && ffmpegReady) return ffmpegInstance;

  // Load the UMD bundle from CDN
  await loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js');
  await loadScript('https://unpkg.com/@ffmpeg/util@0.12.2/dist/umd/util.js');

  const FFmpegLib = (window as any).FFmpegWASM;
  const FFmpegUtil = (window as any).FFmpegUtil;

  if (!FFmpegLib || !FFmpegUtil) {
    throw new Error('FFmpeg.wasm failed to load from CDN');
  }

  const ffmpeg = new FFmpegLib.FFmpeg();

  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
  await ffmpeg.load({
    coreURL: await FFmpegUtil.toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await FFmpegUtil.toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  ffmpegInstance = ffmpeg;
  ffmpegReady = true;
  console.log('[ffmpeg.wasm] Loaded successfully');
  return ffmpeg;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Extract audio from a video file in the browser.
 * Returns a new File object with the extracted MP3 audio.
 */
export async function extractAudioInBrowser(
  videoFile: File,
  onProgress?: (percent: number, status: string) => void
): Promise<File> {
  onProgress?.(5, 'Loading audio extractor...');
  
  const ffmpeg = await loadFFmpegFromCDN();

  onProgress?.(15, 'Reading video file...');

  // Write input file to virtual filesystem
  const inputExt = getExtension(videoFile.name);
  const inputName = `input${inputExt}`;
  const outputName = 'output.mp3';

  // Read file as Uint8Array
  const fileData = new Uint8Array(await videoFile.arrayBuffer());
  await ffmpeg.writeFile(inputName, fileData);

  onProgress?.(25, 'Extracting audio...');

  // Track progress
  ffmpeg.on('progress', ({ progress }: { progress: number }) => {
    const pct = Math.min(90, Math.round(25 + progress * 65));
    onProgress?.(pct, 'Extracting audio...');
  });

  // Extract audio: mono, 32kbps, 22kHz
  await ffmpeg.exec([
    '-i', inputName,
    '-vn',
    '-ac', '1',
    '-ar', '22050',
    '-b:a', '32k',
    '-y',
    outputName,
  ]);

  onProgress?.(92, 'Finalizing...');

  // Read output
  const outputData = await ffmpeg.readFile(outputName);

  // Cleanup virtual FS
  try { await ffmpeg.deleteFile(inputName); } catch {}
  try { await ffmpeg.deleteFile(outputName); } catch {}

  // Create File
  const audioBlob = new Blob([outputData], { type: 'audio/mpeg' });
  const audioFileName = videoFile.name.replace(/\.[^.]+$/, '.mp3');
  const audioFile = new File([audioBlob], audioFileName, { type: 'audio/mpeg' });

  onProgress?.(100, 'Audio extracted!');

  console.log(
    `[audio-extract] ${videoFile.name}: ${(videoFile.size / 1024 / 1024).toFixed(1)}MB → ${(audioFile.size / 1024 / 1024).toFixed(1)}MB (${Math.round((1 - audioFile.size / videoFile.size) * 100)}% smaller)`
  );

  return audioFile;
}

function getExtension(filename: string): string {
  const ext = filename.match(/\.[^.]+$/);
  return ext ? ext[0].toLowerCase() : '.mp4';
}
