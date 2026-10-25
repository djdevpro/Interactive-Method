/**
 * Why a call failed. `retryable` codes depend on the network address the
 * request left from (a proxy, or none): another one may succeed.
 */
export type YtErrorCode =
  /** Neither an address of a video nor its id. */
  | 'INVALID_VIDEO'
  | 'INVALID_LANGUAGE'
  /** YouTube asks to "confirm you're not a bot": the address is flagged. */
  | 'BOT_CHECK'
  /** Private, age-restricted, removed, members only… (`detail` holds YouTube's status). */
  | 'UNPLAYABLE'
  | 'VIDEO_MISMATCH'
  /** The video has no captions at all. */
  | 'NO_CAPTIONS'
  /** It has captions, none in the language asked for. */
  | 'LANGUAGE_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_HTTP'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  /** A proxy of a kind the transport cannot use (a SOCKS proxy with plain `fetch`). */
  | 'PROXY_UNSUPPORTED'
  /** An upload destination refused the transcript or could not be reached. */
  | 'UPLOAD_FAILED';

const RETRYABLE = new Set<YtErrorCode>([
  'BOT_CHECK',
  'RATE_LIMITED',
  'UPSTREAM_HTTP',
  'NETWORK',
  'TIMEOUT',
  'INVALID_RESPONSE',
]);

export class YtError extends Error {
  override readonly name = 'YtError';
  constructor(
    readonly code: YtErrorCode,
    /** HTTP status of YouTube, its playability status, or another hint. */
    readonly detail?: string | number,
    options?: { cause?: unknown },
  ) {
    super(detail === undefined ? code : `${code} (${detail})`, options);
  }

  /** Whether another network address (proxy) could succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export function isYtError(value: unknown): value is YtError {
  return value instanceof YtError;
}
