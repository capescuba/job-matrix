import { useCallback, useEffect, useState } from 'react';

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

/**
 * An always-on-top window (Chrome's Document Picture-in-Picture) to float the coach card over
 * Zoom or Teams. The page's styles and theme are copied in; React renders into it via a portal.
 */
export function usePictureInPicture(onKey?: (e: KeyboardEvent) => void) {
  const [win, setWin] = useState<Window | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof window !== 'undefined' && 'documentPictureInPicture' in window;

  const open = useCallback(async () => {
    const api = window.documentPictureInPicture;
    if (!api) return;
    setError(null);
    let w: Window;
    try {
      w = await api.requestWindow({ width: 520, height: 500 });
    } catch (e) {
      setError(`Could not pop out the card: ${(e as Error).message}`);
      return;
    }
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style'))
      w.document.head.appendChild(node.cloneNode(true));
    const theme = document.documentElement.dataset.theme;
    if (theme) w.document.documentElement.dataset.theme = theme;
    w.document.title = 'Interview coach';
    w.document.body.className = 'bg-bg text-ink p-4 antialiased';
    w.addEventListener('pagehide', () => setWin(null));
    setWin(w);
  }, []);

  useEffect(() => {
    if (!win || !onKey) return;
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  }, [win, onKey]);

  // Closing the tab (or leaving the page) takes the floating window with it.
  useEffect(() => () => win?.close(), [win]);

  return { win, open, close: () => win?.close(), supported, error };
}
