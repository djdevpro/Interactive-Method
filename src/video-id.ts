const VIDEO_ID = /^[\w-]{11}$/;
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const VIDEO_PATHS = new Set(['shorts', 'embed', 'live', 'v']);
// They stand where an id would and are as long as one, yet are not videos.
const NOT_VIDEO_IDS = new Set(['videoseries', 'live_stream']);
const ADDRESSES = /https?:\/\/[^\s<>"]+/g;

/** The id of the video an address points to (`watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/`), or `null`. */
export function parseYouTubeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const [, first, second] = parsed.pathname.split('/');
  let id: string | null | undefined = null;
  if (parsed.hostname === 'youtu.be' || parsed.hostname === 'www.youtu.be')
    id = first;
  else if (HOSTS.has(parsed.hostname)) {
    if (first === 'watch') id = parsed.searchParams.get('v');
    else if (VIDEO_PATHS.has(first ?? '')) id = second;
  }
  return typeof id === 'string' && VIDEO_ID.test(id) && !NOT_VIDEO_IDS.has(id)
    ? id
    : null;
}

/** The id of the video a text stands for: the id alone, an address, or a text holding one. */
export function videoIdOf(text: string): string | null {
  const given = text.trim();
  if (VIDEO_ID.test(given)) return given;
  const direct = parseYouTubeUrl(given);
  if (direct !== null) return direct;
  for (const [address] of given.matchAll(ADDRESSES)) {
    const id = parseYouTubeUrl(address);
    if (id !== null) return id;
  }
  return null;
}

/** The address of a video on YouTube, at a moment of it when `start` (seconds) is given. */
export function watchUrl(videoId: string, start?: number): string {
  const at = start === undefined ? '' : `&t=${Math.floor(start)}s`;
  return `https://www.youtube.com/watch?v=${videoId}${at}`;
}
