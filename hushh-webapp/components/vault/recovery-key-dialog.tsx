// components/vault/recovery-key-dialog.tsx

'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/lib/morphy-ux/morphy';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Copy, Check, Download, AlertTriangle } from 'lucide-react';
import { downloadTextFile } from '@/lib/utils/native-download';
import { Icon } from '@/lib/morphy-ux/ui';
import { copyToClipboard } from '@/lib/utils/clipboard';

interface RecoveryKeyDialogProps {
  open: boolean;
  recoveryKey: string;
  onContinue: () => void;
}

export function RecoveryKeyDialog({
  open,
  recoveryKey,
  onContinue,
}: RecoveryKeyDialogProps) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const handleCopy = async () => {
    try {
      const copiedToClipboard = await copyToClipboard(recoveryKey);
      if (!copiedToClipboard) {
        throw new Error("clipboard_unavailable");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const handleDownload = async () => {
    const content = `Hussh Vault Recovery Key\n\n${recoveryKey}\n\nKeep this safe! You'll need it if you forget your passphrase.`;
    const success = await downloadTextFile(content, 'hushh-recovery-key.txt');
    if (success) {
      setDownloaded(true);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-lg" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={AlertTriangle} size="lg" className="text-orange-500" />
            Save Your Recovery Key
          </DialogTitle>
          <DialogDescription>
            This is the ONLY way to recover your vault if you forget your passphrase.
            Save it somewhere safe!
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <Alert className="app-critical-alert">
            <Icon icon={AlertTriangle} size="sm" />
            <AlertDescription>
              <strong>Warning:</strong> This recovery key will only be shown once. 
              We cannot recover it for you if you lose it.
            </AlertDescription>
          </Alert>

          <div className="p-4 bg-muted rounded-lg border-2 border-dashed">
            <code className="text-sm font-mono break-all">
              {recoveryKey}
            </code>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={handleCopy}
              className="w-full"
            >
              {copied ? (
                <>
                  <Icon icon={Check} size="sm" className="mr-2" />
                  Copied!
                </>
              ) : (
                <>
                  <Icon icon={Copy} size="sm" className="mr-2" />
                  Copy Key
                </>
              )}
            </Button>

            <Button
              onClick={handleDownload}
              className="w-full"
            >
              <Icon icon={Download} size="sm" className="mr-2" />
              {downloaded ? 'Downloaded' : 'Download'}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={onContinue}
            variant="gradient"
            effect="glass"
            className="w-full"
            disabled={!copied && !downloaded}
          >
            I've Saved My Recovery Key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
