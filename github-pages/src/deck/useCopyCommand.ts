// Source L1006-1022 — clipboard write with a detached-<textarea> +
// execCommand fallback for browsers/contexts where the async Clipboard API
// is unavailable or rejects.

import { useCallback, useState } from 'react';

export type CopyStatus = 'idle' | 'copied' | 'blocked';

export interface UseCopyCommandResult {
  status: CopyStatus;
  copy: () => Promise<void>;
}

export function useCopyCommand(text: string): UseCopyCommandResult {
  const [status, setStatus] = useState<CopyStatus>('idle');

  const copy = useCallback(async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(area);
      area.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        // ok stays false
      }
      area.remove();
    }
    setStatus(ok ? 'copied' : 'blocked');
  }, [text]);

  return { status, copy };
}
