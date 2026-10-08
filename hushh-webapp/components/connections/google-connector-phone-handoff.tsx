'use client';

import { useMemo } from 'react';
import { encodeQrCode } from '@/components/wallet-card/qr-code';
import type { PhoneHandoff } from '@/lib/one/google-native-connect';

export function GoogleConnectorPhoneHandoff({ handoff }: { handoff: PhoneHandoff }) {
  const matrix = useMemo(() => encodeQrCode(handoff.deepLink), [handoff.deepLink]);
  const path = Array.from(matrix.modules).flatMap((dark, index) => dark
    ? [`M${index % matrix.size + 4} ${Math.floor(index / matrix.size) + 4}h1v1h-1z`] : []).join('');
  return <div className="space-y-3 rounded-2xl border p-4">
    <p className="text-sm font-medium">Finish connecting on your phone</p>
    <svg role="img" aria-label="Scan to connect Google on your phone" className="mx-auto h-48 w-48"
      viewBox={`0 0 ${matrix.size + 8} ${matrix.size + 8}`} shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="white" /><path d={path} fill="black" />
    </svg>
    <p className="text-sm text-muted-foreground">Scan with your phone, then sign in and unlock the Hussh app. Your phone connects to your own private agent.</p>
    <a className="flex min-h-11 items-center justify-center text-sm underline" href={handoff.deepLink}>Open in the Hussh app</a>
  </div>;
}
