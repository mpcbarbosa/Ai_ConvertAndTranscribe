/**
 * Browser-side audio extraction using FFmpeg.wasm
 * Converts video files to small MP3 audio files before upload.
 * This dramatically reduces upload size (e.g., 467MB video → ~45MB audio).
 */

let ffmpegLoaded = false;
let ffmpegInstance: any = null;

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || 
    /\.(mp4|mov|mkv|webm|avi|m4v|flv|wmv)$/i.test(file.name);
}

export async function getFFmpeg() {
  if (ffmpegInstance && ffmpegLoaded) return ffmpegInstance;

  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const ffmpeg = new FFmpeg();

  ffmpeg.on('log', ({ message }: { message: string }) => {
    // Only log important messages
    if (message.includes('time=') || message.includes('error') || message.includes('Error')) {
      console.log('[ffmpeg.wasm]', message);
    }
  });

  // Load ffmpeg core from CDN
  const { toBlobURL } = await import('@ffmpeg/util');
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  ffmpegInstance = ffmpeg;
  ffmpegLoaded = true;
  return ffmpeg;
}

/**
 * Extract audio from a video file in the browser.
 * Returns a new File object with the extracted MP3 audio.
 * 
 * @param videoFile - The video file to extract audio from
 * @param onProgress - Progress callback (0-100)
 * @returns MP3 file, much smaller than the original video
 */
export async function extractAudioInBrowser(
  videoFile: File,
  onProgress?: (percent: number, status: string) => void
): Promise<File> {
  onProgress?.(0, 'Loading audio extractor...');
  
  const ffmpeg = await getFFmpeg();
  const { fetchFile } = await import('@ffmpeg/util');

  onProgress?.(10, 'Reading video file...');

  // Write input file to virtual filesystem
  const inputName = 'input' + getExtension(videoFile.name);
  const outputName = 'output.mp3';

  await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

  onProgress?.(30, 'Extracting audio...');

  // Set up progress tracking
  ffmpeg.on('progress', ({ progress }: { progress: number }) => {
    const pct = Math.round(30 + progress * 60); // 30-90%
    onProgress?.(pct, 'Extracting audio...');
  });

  // Extract audio: mono, 32kbps, 22kHz (matches server settings)
  await ffmpeg.exec([
    '-i', inputName,
    '-vn',              // No video
    '-ac', '1',         // Mono
    '-ar', '22050',     // 22kHz sample rate
    '-b:a', '32k',      // 32kbps bitrate
    '-y',               // Overwrite
    outputName,
  ]);

  onProgress?.(90, 'Finalizing...');

  // Read output file
  const outputData = await ffmpeg.readFile(outputName);
  
  // Cleanup virtual filesystem
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  // Create new File object
  const audioBlob = new Blob([outputData], { type: 'audio/mpeg' });
  const audioFileName = videoFile.name.replace(/\.[^.]+$/, '.mp3');
  const audioFile = new File([audioBlob], audioFileName, { type: 'audio/mpeg' });

  onProgress?.(100, 'Audio extracted!');

  console.log(`[audio-extract] ${videoFile.name}: ${(videoFile.size / 1024 / 1024).toFixed(1)}MB → ${(audioFile.size / 1024 / 1024).toFixed(1)}MB (${Math.round((1 - audioFile.size / videoFile.size) * 100)}% smaller)`);

  return audioFile;
}

function getExtension(filename: string): string {
  const ext = filename.match(/\.[^.]+$/);
  return ext ? ext[0].toLowerCase() : '.mp4';
}
