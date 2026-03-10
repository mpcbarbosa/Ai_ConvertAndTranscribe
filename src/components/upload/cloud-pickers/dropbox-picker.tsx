'use client';

import { useCallback } from 'react';

interface Props {
  onFileSelected: (file: File) => void;
  onError: (error: string) => void;
  disabled?: boolean;
}

const DROPBOX_APP_KEY = process.env.NEXT_PUBLIC_DROPBOX_APP_KEY || '';

export function DropboxPicker({ onFileSelected, onError, disabled }: Props) {
  const handleClick = useCallback(async () => {
    if (!DROPBOX_APP_KEY) {
      onError('Dropbox is not configured');
      return;
    }

    try {
      await loadScript('https://www.dropbox.com/static/api/2/dropins.js', {
        'data-app-key': DROPBOX_APP_KEY,
        id: 'dropboxjs',
      });

      Dropbox.choose({
        success: async (files: Array<{ link: string; name: string; bytes: number }>) => {
          const item = files[0];
          if (!item) return;

          try {
            const response = await fetch(item.link);
            if (!response.ok) throw new Error('Download failed');

            const blob = await response.blob();
            // Infer mime type from extension
            const ext = item.name.split('.').pop()?.toLowerCase() || '';
            const mimeMap: Record<string, string> = {
              mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
              webm: 'video/webm', avi: 'video/x-msvideo', mp3: 'audio/mpeg',
              wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
            };
            const mimeType = mimeMap[ext] || 'application/octet-stream';
            const file = new File([blob], item.name, { type: mimeType });
            onFileSelected(file);
          } catch {
            onError('Failed to download file from Dropbox');
          }
        },
        cancel: () => { /* User cancelled */ },
        linkType: 'direct',
        multiselect: false,
        extensions: ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.mp3', '.wav', '.m4a', '.ogg'],
        folderselect: false,
        sizeLimit: 524288000, // 500 MB
      });
    } catch (err) {
      onError('Failed to load Dropbox picker');
      console.error(err);
    }
  }, [onFileSelected, onError]);

  if (!DROPBOX_APP_KEY) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="#0061FF">
        <path d="M6 2l6 3.75L6 9.5 0 5.75zM18 2l6 3.75-6 3.75-6-3.75zM0 13.25L6 9.5l6 3.75L6 17zM18 9.5l6 3.75L18 17l-6-3.75zM6 18.25l6-3.75 6 3.75-6 3.75z"/>
      </svg>
      Dropbox
    </button>
  );
}

function loadScript(src: string, attrs?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    if (attrs) Object.entries(attrs).forEach(([k, v]) => script.setAttribute(k, v));
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

declare const Dropbox: {
  choose: (options: unknown) => void;
};
