#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createYouTubeClient } from './client.js';
import { isYtError } from './errors.js';
import { nodeTransport } from './node.js';
import { parseProxyList } from './proxy/parse.js';
import type { DirectPolicy, RotationStrategy } from './proxy/types.js';
import { formatTranscript, TRANSCRIPT_FORMATS, type TranscriptFormat } from './transcript.js';
import { transcriptPayload, uploadTranscript } from './upload.js';
import { collectResult } from './cli/acquisition.js';
import { downloadVideo } from './cli/download.js';
import { CommandError, numberOption, required } from './cli/files.js';
import { runLocalCommand } from './cli/runtime.js';

// Video command used by the plugin.
// Prints the result on stdout; errors go to stderr as one JSON line with
// their code, and the exit code is 1.

const HELP = `node runtime/video.mjs <command> <video> [options]

Commands
  transcript <video>   The transcript (default format: timed-text)
  info <video>         The video as JSON: title, channel, duration, description,
                       thumbnail, caption tracks (stream URLs with --streams)
  send <video>         Sends the transcript (yt-max.transcript/v1 JSON) to --to
  collect <video>      Saves transcript, metadata and provenance in --out <directory>
  import <file>        Imports SRT/VTT/JSON locally; needs --video, --source and --out
  download <video>     Downloads one video stream to --out <file.mp4|file.webm>
  frames <file>        Targeted local video captures; needs --out, --method and a plan
  clip <file>          A local video interval; needs --out <file.mp4>, --start and --duration
  doctor              Checks Node and FFmpeg availability without network requests

<video> is a YouTube URL or an 11-character id.

Options
  -l, --lang <codes>     Preferred languages, best first: fr,en (default: the one spoken)
      --translate        If no track is in those languages, ask YouTube to translate
  -f, --format <name>    text | timed-text | srt | vtt | json | markdown
      --streams          info: include the signed stream URLs
      --to <url>         send: the endpoint
  -H, --header <h>       send: a header, "Name: value" (repeatable)
      --proxies <file>   One proxy per line (or YT_MAX_PROXIES, comma or newline separated)
      --rotation <name>  smart | round-robin | random
      --direct <policy>  fallback | first | mix | never
      --out <path>       Explicit output directory or file; existing files are refused
      --video <id/url>   import: required YouTube identity; frames: optional provenance
      --source <text>    import: required description of transcript acquisition
      --title <text>     import: supplied video title (not fetched)
      --author <text>    import: supplied channel/author (not fetched)
      --max-height <n>   download: maximum height, default 720 (144–2160)
      --max-mb <n>       download: maximum MiB, default 1024 (1–4096)
      --method <id>      frames: method identifier (letters, digits, _ or -)
      --times <seconds>  frames: 1–12 comma-separated times, e.g. 12,30.5,61
      --reason <text>    frames: reason for these captures (with --times)
      --plan <json>      frames: array of {time,reason,role?}, instead of --times
      --width <pixels>   frames: maximum width, default 1280 (320–3840)
      --start <seconds>  clip: start time
      --duration <sec>   clip: duration from 0.1 to 120 seconds
  -v, --verbose          Logs each refused attempt to stderr
  -h, --help
`;

function fail(code: string, message: string): never {
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lang: { type: 'string', short: 'l' },
      translate: { type: 'boolean' },
      format: { type: 'string', short: 'f' },
      streams: { type: 'boolean' },
      to: { type: 'string' },
      header: { type: 'string', short: 'H', multiple: true },
      proxies: { type: 'string' },
      rotation: { type: 'string' },
      direct: { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      out: { type: 'string' },
      video: { type: 'string' },
      source: { type: 'string' },
      title: { type: 'string' },
      author: { type: 'string' },
      'max-height': { type: 'string' },
      'max-mb': { type: 'string' },
      method: { type: 'string' },
      times: { type: 'string' },
      reason: { type: 'string' },
      plan: { type: 'string' },
      width: { type: 'string' },
      start: { type: 'string' },
      duration: { type: 'string' },
    },
  });
  const [command, video] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length > 2) fail('USAGE', 'Unexpected positional arguments. Quote paths and text containing spaces.');
  if (await runLocalCommand(command, video, values)) return;
  if (!video) fail('USAGE', `Missing <video>. ${command === 'help' ? '' : 'Run node runtime/video.mjs --help.'}`);

  if (values.rotation && !['smart', 'round-robin', 'random'].includes(values.rotation)) fail('USAGE', 'Invalid --rotation.');
  if (values.direct && !['fallback', 'first', 'mix', 'never'].includes(values.direct)) fail('USAGE', 'Invalid --direct policy.');

  const proxyText = values.proxies
    ? readFileSync(values.proxies, 'utf8')
    : (process.env.YT_MAX_PROXIES ?? '').replaceAll(',', '\n');
  const yt = createYouTubeClient({
    transport: nodeTransport(),
    proxies: parseProxyList(proxyText),
    rotation: values.rotation as RotationStrategy | undefined,
    direct: values.direct as DirectPolicy | undefined,
    onAttempt: values.verbose ? (event) => process.stderr.write(`${JSON.stringify({ refused: event })}\n`) : undefined,
  });
  const languages = values.lang
    ?.split(/[,\s]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  switch (command) {
    case 'collect': {
      const directory = required(values.out, '--out');
      const result = await yt.getTranscript(video, { languages, translate: values.translate });
      process.stdout.write(`${JSON.stringify(await collectResult(result, directory), null, 2)}\n`);
      return;
    }
    case 'download': {
      const out = required(values.out, '--out');
      const maxHeight = numberOption(values['max-height'], '--max-height', 720, 144, 2160);
      if (!Number.isInteger(maxHeight)) fail('USAGE', '--max-height must be an integer.');
      const maxBytes = Math.floor(numberOption(values['max-mb'], '--max-mb', 1024, 1, 4096) * 1024 * 1024);
      const info = await yt.getVideo(video, { languages, translate: values.translate });
      process.stdout.write(`${JSON.stringify(await downloadVideo(yt, info, { out, maxHeight, maxBytes }), null, 2)}\n`);
      return;
    }
    case 'info': {
      const info = await yt.getVideo(video, { languages, translate: values.translate });
      const { streams, transcript, ...rest } = info;
      const out = values.streams ? info : { ...rest, transcript: { ...transcript, url: undefined } };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }
    case 'transcript': {
      const format = (values.format ?? 'timed-text') as TranscriptFormat;
      if (!(format in TRANSCRIPT_FORMATS)) fail('USAGE', `Unknown format: ${format}`);
      const { video: info, transcript } = await yt.getTranscript(video, { languages, translate: values.translate });
      process.stdout.write(`${formatTranscript(transcript, format, info)}\n`);
      return;
    }
    case 'send': {
      if (!values.to) fail('USAGE', 'send needs --to <url>');
      const headers: Record<string, string> = {};
      for (const line of values.header ?? []) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
      const { video: info, transcript } = await yt.getTranscript(video, { languages, translate: values.translate });
      const result = await uploadTranscript(
        { id: 'cli', name: values.to, url: values.to, headers },
        transcriptPayload(info, transcript, 'yt-max-cli'),
      );
      process.stdout.write(`${JSON.stringify({ sent: info.id, status: result.status, body: result.body })}\n`);
      return;
    }
    default:
      fail('USAGE', `Unknown command: ${command}. Run node runtime/video.mjs --help.`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof CommandError) fail(error.code, error.message);
  if (isYtError(error)) fail(error.code, error.message);
  if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') fail('OUTPUT_EXISTS', 'Output already exists; choose a new output path.');
  if (String((error as NodeJS.ErrnoException)?.code ?? '').startsWith('ERR_PARSE_ARGS')) fail('USAGE', (error as Error).message);
  fail('FAILED', error instanceof Error ? error.message : String(error));
});
