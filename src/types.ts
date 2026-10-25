/** A caption track: its language, and whether YouTube made it by speech recognition. */
export interface CaptionTrack {
  language: string;
  /** The name YouTube shows (`French (auto-generated)`), when it gives one. */
  name: string | null;
  automatic: boolean;
}

/** One stream as YouTube serves it: a signed direct address, good for a few hours. */
export interface Stream {
  itag: number;
  /** With its codecs: `video/mp4; codecs="avc1.640028"`. */
  mime: string;
  url: string;
  /** Size in bytes when YouTube says it (`clen`). */
  size: number | null;
}

export interface VideoStream extends Stream {
  /** `1080p60`, `720p`… */
  quality: string | null;
  fps: number | null;
}

export interface AudioStream extends Stream {
  bitrate: number | null;
  /** The language of a dubbed track (`fr.3`); `null` for a video with one track. */
  language: string | null;
  /** The track YouTube plays first: the language of the video. */
  default: boolean | null;
  /** A copy made quieter in its loud parts (dynamic range compression). */
  drc: boolean;
}

/** YouTube mostly serves picture and sound apart; `muxed` holds the few with both. */
export interface Streams {
  video: VideoStream[];
  audio: AudioStream[];
  muxed: VideoStream[];
}

export type TranscriptChoice =
  | (CaptionTrack & { url: string })
  | { url: null; reason: 'NO_CAPTIONS' | 'LANGUAGE_UNAVAILABLE' };

/** What YouTube says of a video, its caption tracks, the one chosen and its streams. */
export interface VideoInfo {
  id: string;
  title: string;
  author: string;
  channelId: string | null;
  /** Seconds; `null` for a live stream. */
  lengthSeconds: number | null;
  description: string;
  /** The largest thumbnail on YouTube's image server. */
  thumbnail: string | null;
  isLive: boolean;
  captions: CaptionTrack[];
  /** The language spoken, as far as YouTube tells it (`fr`), or `''`. */
  spokenLanguage: string;
  /** The track picked for the transcript, with its signed address. */
  transcript: TranscriptChoice;
  /** Seconds since 1970 when the first signed address stops working; `null` when unknown. */
  expires: number | null;
  streams: Streams;
}

/** One line of a transcript: when it is said and for how long (seconds), and what. */
export interface TranscriptLine {
  start: number;
  duration: number;
  text: string;
}

export interface Transcript {
  videoId: string;
  language: string;
  automatic: boolean;
  lines: TranscriptLine[];
}
