'use client';

import { useCallback } from 'react';

interface Props {
  onFileSelected: (file: File) => void;
  onError: (error: string) => void;
  disabled?: boolean;
}

const ONEDRIVE_CLIENT_ID = process.env.NEXT_PUBLIC_ONEDRIVE_CLIENT_ID || '';

export function OneDrivePicker({ onFileSelected, onError, disabled }: Props) {
  const handleClick = useCallback(async () => {
    if (!ONEDRIVE_CLIENT_ID) {
      onError('OneDrive is not configured');
      return;
    }

    try {
      await loadScript('https://js.live.net/v7.2/OneDrive.js');

      const odOptions = {
        clientId: ONEDRIVE_CLIENT_ID,
        action: 'download',
        multiSelect: false,
        openInNewWindow: true,
        advanced: {
          filter: '.mp4,.mov,.mkv,.webm,.avi,.mp3,.wav,.m4a,.ogg',
          redirectUri: window.location.origin,
        },
        success: async (files: { value: Array<{ name: string; '@microsoft.graph.downloadUrl': string; file?: { mimeType: string }; size: number }> }) => {
          const item = files.value[0];
          if (!item) return;

          try {
            const downloadUrl = item['@microsoft.graph.downloadUrl'];
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error('Download failed');

            const blob = await response.blob();
            const mimeType = item.file?.mimeType || 'application/octet-stream';
            const file = new File([blob], item.name, { type: mimeType });
            onFileSelected(file);
          } catch {
            onError('Failed to download file from OneDrive');
          }
        },
        cancel: () => { /* User cancelled */ },
        error: (err: { errorCode?: string; message?: string }) => {
          onError(err.message || 'OneDrive picker error');
        },
      };

      OneDrive.open(odOptions);
    } catch (err) {
      onError('Failed to load OneDrive picker');
      console.error(err);
    }
  }, [onFileSelected, onError]);

  if (!ONEDRIVE_CLIENT_ID) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
        <path d="M10.086 8.198L14.5 5.5c.6-.3 1.3-.5 2-.5 1.1 0 2.2.4 3 1.2.8.8 1.2 1.8 1.3 2.9h.2c1.1 0 2.1.4 2.8 1.2.7.7 1.2 1.7 1.2 2.8 0 1.1-.4 2.1-1.2 2.8-.7.8-1.7 1.2-2.8 1.2H6.5c-1.4 0-2.7-.6-3.7-1.5C1.9 14.5 1.3 13.3 1.3 12c0-1.3.6-2.5 1.5-3.4.9-.9 2.1-1.5 3.4-1.6.5-1.2 1.5-2.2 2.8-2.8z" fill="#0078D4"/>
        <path d="M10.086 8.198l4.414 7.902H6.5c-1.4 0-2.7-.6-3.7-1.5C1.9 14.5 1.3 13.3 1.3 12c0-1.3.6-2.5 1.5-3.4.9-.9 2.1-1.5 3.4-1.6.5-1.2 1.5-2.2 2.8-2.8l1.086 4z" fill="#0364B8"/>
        <path d="M14.5 16.1l-4.414-7.902L14.5 5.5c.6-.3 1.3-.5 2-.5 1.1 0 2.2.4 3 1.2.8.8 1.2 1.8 1.3 2.9h.2c1.1 0 2.1.4 2.8 1.2.7.7 1.2 1.7 1.2 2.8 0 1.1-.4 2.1-1.2 2.8-.7.8-1.7 1.2-2.8 1.2H14.5z" fill="#28A8EA"/>
      </svg>
      OneDrive
    </button>
  );
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

declare const OneDrive: {
  open: (options: unknown) => void;
};
