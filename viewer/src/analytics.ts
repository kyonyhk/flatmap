// Privacy-clean analytics: a thin wrapper over the self-hosted Umami
// tracker. Fires only aggregate interaction events (event name + coarse
// labels like a town name), never anything identifying. No-ops silently if
// the tracker script is absent — adblocked, offline, or not yet configured
// — so nothing here can break the page or block on a network call.
export function track(event: string, data?: Record<string, string | number>) {
  try {
    (window as { umami?: { track: (e: string, d?: unknown) => void } }).umami?.track(event, data);
  } catch {
    /* analytics must never throw into the app */
  }
}
