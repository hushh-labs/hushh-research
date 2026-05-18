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
import { Download, AlertTriangle } from 'lucide-react';
import { downloadTextFile } from '@/lib/utils/native-download';
import { Icon } from '@/lib/morphy-ux/ui';

// HARVESTED CLIPBOARD MICROINTERACTION
import { ClipboardCopy } from "@/components/app-ui/clipboard-copy";

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
  // We removed the manual 'copied' state; the ClipboardCopy component manages its own feedback loop!
  const [downloaded, setDownloaded] = useState(false);
  
  // To keep the "Continue" button safely disabled until they interact with one of the options,
  // we add a simple interaction tracker
  const [hasInteracted, setHasInteracted] = useState(false);

  const handleDownload = async () => {
    const content = `Hushh Vault Recovery Key\n\n${recoveryKey}\n\nKeep this safe! You'll need it if you forget your passphrase.`;
    const success = await downloadTextFile(content, 'hushh-recovery-key.txt');
    if (success) {
      setDownloaded(true);
      setHasInteracted(true);
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

          <div className="p-4 bg-muted rounded-lg border-2 border-dashed relative">
            <code className="text-sm font-mono break-all pr-12 block">
              {recoveryKey}
            </code>
            
            {/* HARVESTED CLIPBOARD COMPONENT */}
            {/* Positioned absolutely inside the key block for a clean UI */}
            <div className="absolute top-3 right-3">
              <ClipboardCopy 
                value={recoveryKey} 
                onCopy={() => setHasInteracted(true)} 
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {/* The old manual copy button was completely removed from here */}
            <Button
              onClick={handleDownload}
              className="w-full"
            >
              <Icon icon={Download} size="sm" className="mr-2" />
              {downloaded ? 'Downloaded' : 'Download Backup File'}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={onContinue}
            variant="gradient"
            effect="glass"
            className="w-full"
            disabled={!hasInteracted}
          >
            I've Saved My Recovery Key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}