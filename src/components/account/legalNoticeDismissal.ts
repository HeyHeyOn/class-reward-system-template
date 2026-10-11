// Remembers, in this browser, that a teacher put away the notice of a coming revision of the terms.
// The close button hides it for this tab until the tab is closed; '다시 보지 않기' hides it for good.
// Each revision has its own key, so a later revision is announced again.

const key = (version: string) => `crs-legal-notice:${version}`;
const listeners = new Set<() => void>();
// When the browser refuses storage, the notice still stays away while this page is open.
const hiddenHere = new Set<string>();

export function subscribeLegalNotice(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function legalNoticeHidden(version: string): boolean {
  if (hiddenHere.has(version)) return true;
  try {
    return window.localStorage.getItem(key(version)) === 'hidden' || window.sessionStorage.getItem(key(version)) === 'closed';
  } catch {
    return false;
  }
}

export function hideLegalNotice(version: string, forGood: boolean) {
  hiddenHere.add(version);
  try {
    if (forGood) window.localStorage.setItem(key(version), 'hidden');
    else window.sessionStorage.setItem(key(version), 'closed');
  } catch { /* Remembering is a convenience; the notice is hidden on this page either way. */ }
  for (const listener of listeners) listener();
}

/** For tests: forget what this page hid. */
export function resetLegalNoticeDismissals() {
  hiddenHere.clear();
}
