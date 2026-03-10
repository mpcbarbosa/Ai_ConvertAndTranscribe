'use client';

import { GoogleDrivePicker } from './google-drive-picker';
import { OneDrivePicker } from './onedrive-picker';
import { DropboxPicker } from './dropbox-picker';
import { Cloud } from 'lucide-react';

interface Props {
  onFileSelected: (file: File) => void;
  onError: (error: string) => void;
  disabled?: boolean;
  t: (key: string) => string;
}

export function CloudPickers({ onFileSelected, onError, disabled, t }: Props) {
  const hasAnyProvider = 
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
    process.env.NEXT_PUBLIC_ONEDRIVE_CLIENT_ID ||
    process.env.NEXT_PUBLIC_DROPBOX_APP_KEY;

  if (!hasAnyProvider) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Cloud className="h-4 w-4" />
        <span>{t('upload.cloud_import')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <GoogleDrivePicker onFileSelected={onFileSelected} onError={onError} disabled={disabled} />
        <OneDrivePicker onFileSelected={onFileSelected} onError={onError} disabled={disabled} />
        <DropboxPicker onFileSelected={onFileSelected} onError={onError} disabled={disabled} />
      </div>
    </div>
  );
}
