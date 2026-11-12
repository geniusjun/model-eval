import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { formatHash, parseHash, type PageHash } from '../utils/hash.js';

// plan D3: the hash is the one source of the reader's place. It is written through
// `location.hash` only, because `file://` pages have an opaque origin where browsers reject
// some `history.pushState` URLs.

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
}

function currentHash(): string {
  return window.location.hash;
}

export function useHashParam(): readonly [PageHash, (next: PageHash) => void] {
  const hash = useSyncExternalStore(subscribe, currentHash);
  const parsed = useMemo(() => parseHash(hash), [hash]);
  const setHash = useCallback((next: PageHash) => {
    window.location.hash = formatHash(next);
  }, []);
  return [parsed, setHash];
}
