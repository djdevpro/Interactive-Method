import { importTranscript } from './acquisition.js';
import { capturePoints, doctor, extractClip, extractFrames } from './ffmpeg.js';
import { required } from './files.js';

export type CommandValues = Record<string, string | boolean | string[] | undefined>;
export const textValue = (values: CommandValues, key: string): string | undefined =>
  typeof values[key] === 'string' ? values[key] as string : undefined;

/** Local commands need neither a YouTube request nor proxy credentials. */
export async function runLocalCommand(command: string, input: string | undefined, values: CommandValues): Promise<boolean> {
  let result: object;
  switch (command) {
    case 'doctor': {
      const health = await doctor() as { ready: boolean };
      process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
      if (!health.ready) process.exitCode = 1;
      return true;
    }
    case 'import':
      result = await importTranscript(required(input, '<transcript file>'), {
        video: required(values.video, '--video'), directory: required(values.out, '--out'),
        source: required(values.source, '--source'), title: textValue(values, 'title'), author: textValue(values, 'author'),
        language: textValue(values, 'lang'),
      });
      break;
    case 'frames':
      result = await extractFrames(required(input, '<local video>'), {
        directory: required(values.out, '--out'), method: required(values.method, '--method'), width: textValue(values, 'width'),
        video: textValue(values, 'video'), points: await capturePoints({ times: textValue(values, 'times'),
          reason: textValue(values, 'reason'), plan: textValue(values, 'plan') }),
      });
      break;
    case 'clip':
      result = await extractClip(required(input, '<local video>'), {
        out: required(values.out, '--out'), start: textValue(values, 'start'), duration: textValue(values, 'duration'),
      });
      break;
    default: return false;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return true;
}
