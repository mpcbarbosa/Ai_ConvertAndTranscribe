'use client';

import { useCallback } from 'react';

interface Props {
  onFileSelected: (file: File) => void;
  onError: (error: string) => void;
  disabled?: boolean;
}

const GOOGLE_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';

export function GoogleDrivePicker({ onFileSelected, onError, disabled }: Props) {
  const handleClick = useCallback(async () => {
    if (!GOOGLE_API_KEY || !GOOGLE_CLIENT_ID) {
      onError('Google Drive is not configured');
      return;
    }

    try {
      // Load Google API scripts dynamically
      await loadScript('https://apis.google.com/js/api.js');
      await loadScript('https://accounts.google.com/gsi/client');

      // Initialize the token client
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: (tokenResponse: { access_token?: string; error?: string }) => {
          if (tokenResponse.error || !tokenResponse.access_token) {
            onError('Google authentication failed');
            return;
          }
          openPicker(tokenResponse.access_token);
        },
      });

      tokenClient.requestAccessToken();
    } catch (err) {
      onError('Failed to load Google Drive picker');
      console.error(err);
    }
  }, [onFileSelected, onError]);

  const openPicker = useCallback((accessToken: string) => {
    gapi.load('picker', () => {
      const videoMimeTypes = 'video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo';
      const audioMimeTypes = 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/webm,audio/ogg';

      const picker = new google.picker.PickerBuilder()
        .addView(
          new google.picker.DocsView()
            .setMimeTypes(`${videoMimeTypes},${audioMimeTypes}`)
            .setMode(google.picker.DocsViewMode.LIST)
        )
        .setOAuthToken(accessToken)
        .setDeveloperKey(GOOGLE_API_KEY)
        .setCallback(async (data: { action: string; docs?: Array<{ id: string; name: string; mimeType: string; sizeBytes?: number }> }) => {
          if (data.action === google.picker.Action.PICKED && data.docs?.[0]) {
            const doc = data.docs[0];
            try {
              // Download the file via Google Drive API
              const response = await fetch(
                `https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (!response.ok) throw new Error('Failed to download from Google Drive');

              const blob = await response.blob();
              const file = new File([blob], doc.name, { type: doc.mimeType });
              onFileSelected(file);
            } catch {
              onError('Failed to download file from Google Drive');
            }
          }
        })
        .build();

      picker.setVisible(true);
    });
  }, [onFileSelected, onError]);

  if (!GOOGLE_API_KEY || !GOOGLE_CLIENT_ID) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
        <path d="M4.433 22l-1.766-3.062 7.1-12.31 1.767 3.062L4.433 22z" fill="#0066DA"/>
        <path d="M15.5 22H4.433l1.766-3.062h11.068L15.5 22z" fill="#00AC47"/>
        <path d="M22.333 15.876L20.567 18.938H9.5l1.766-3.062h11.067z" fill="#00832D"/>
        <path d="M15.5 6.628l1.766 3.062-7.1 12.31H8.4l7.1-12.31V6.628z" fill="#2684FC"/>
        <path d="M15.5 6.628L9.833 3.566l-1.766 3.062L15.5 6.628z" fill="#EA4335"/>
        <path d="M22.333 15.876L15.5 6.628l1.766-3.062 5.067 12.31z" fill="#FFBA00"/>
      </svg>
      Google Drive
    </button>
  );
}

// Helper to load external scripts
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

// Type declarations for Google APIs
declare const gapi: {
  load: (api: string, callback: () => void) => void;
};
declare const google: {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: { access_token?: string; error?: string }) => void;
      }) => { requestAccessToken: () => void };
    };
  };
  picker: {
    PickerBuilder: new () => {
      addView: (view: unknown) => ReturnType<typeof Object>;
      setOAuthToken: (token: string) => ReturnType<typeof Object>;
      setDeveloperKey: (key: string) => ReturnType<typeof Object>;
      setCallback: (cb: (data: unknown) => void) => ReturnType<typeof Object>;
      build: () => { setVisible: (v: boolean) => void };
    };
    DocsView: new () => {
      setMimeTypes: (types: string) => ReturnType<typeof Object>;
      setMode: (mode: unknown) => ReturnType<typeof Object>;
    };
    DocsViewMode: { LIST: unknown };
    Action: { PICKED: string };
  };
};
