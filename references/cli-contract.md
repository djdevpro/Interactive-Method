# Using the bundled video tools

The video program is in `runtime/video.mjs`. Resolve `<PLUGIN>` two directories above `skills/<name>/SKILL.md`, regardless of the current working directory. Replace example placeholders with the selected absolute paths and quote them appropriately for the shell.

The CLI requires Node.js >=22.19.0. FFmpeg handles images and clips; `doctor` reports its availability. The current distribution may include its binary; another system needs a compatible FFmpeg on PATH or through `YT_MAX_FFMPEG`. The installed runtime's help command is the authority for supported options.

```sh
node "<PLUGIN>/runtime/video.mjs" --help
node "<PLUGIN>/runtime/video.mjs" doctor
node "<PLUGIN>/runtime/video.mjs" collect "<VIDEO_URL>" --out "<WORKSPACE>/sources/main" -l en
```

Use the video's actual language preferences when selecting transcripts. Collecting the requested video is part of the primary analysis. Fetching additional videos or other supplementary sources requires an explicit request from the human asking for the analysis, as described in the [research protocol](research-protocol.md).

`collect` saves the following UTF-8 files.

| File | Content |
| --- | --- |
| `video.json` | Video metadata without signed stream URLs |
| `transcript.json` | `{ videoId, language, automatic, lines: [{ start, duration, text }] }`; times in seconds |
| `transcript.srt` | Timestamped subtitles |
| `transcript.md` | Readable transcript |
| `acquisition.json` | Acquisition origin, mode and date |

Output commands refuse to overwrite existing files. To resume, reuse valid files or create a new acquisition or revision folder. Do not erase an earlier result to bypass this safeguard.

## Transcript obtained through the host

If YouTube refuses direct retrieval, use the host's available official transcription tool, a transcript visible in the browser or a supplied file. Keep the raw file and its origin. Convert only data actually retrieved; do not invent timestamps for untimed text.

```sh
node "<PLUGIN>/runtime/video.mjs" import "<FILE.srt>" --video "<VIDEO_URL>" --out "<WORKSPACE>/sources/main-import" --source "Transcript exported from the connected browser" --lang en
```

`import` accepts SRT, VTT or compatible JSON without network requests. The `--title` and `--author` options can record verified metadata. Retain direct retrieval errors as acquisition limitations, not content findings.

## Download and inspect during the first pass

```sh
node "<PLUGIN>/runtime/video.mjs" download "<VIDEO_URL>" --out "<WORKSPACE>/media/video.mp4" --max-height 720 --max-mb 1024
node "<PLUGIN>/runtime/video.mjs" frames "<WORKSPACE>/media/video.mp4" --out "<WORKSPACE>/methods/M01/captures/pass-01" --times 12,30.5,61 --method M01 --reason "Inspect the initial state, action and result"
node "<PLUGIN>/runtime/video.mjs" clip "<WORKSPACE>/media/video.mp4" --out "<WORKSPACE>/methods/M01/transition.mp4" --start 29 --duration 8
```

Choose moments after reading the relevant content, and extract and inspect them before presenting the first overview. These operations are not postponed until the user requests deeper analysis. `download` saves the video and its provenance in a `.json` file. Check whether the stream contains audio before presenting it as a complete audiovisual copy. Stream URLs expire and must be retrieved again when necessary.

`frames` produces PNG files and `captures.json` with timestamps, method, reason and provenance. The manifest starts with `reviewed: false`. Inspect each image before citing it, then record its role and retention decision in the method card. A revisit uses a new folder to preserve earlier evidence.

To assign a different reason to each capture, supply `--plan "<PLAN.json>"` instead of `--times`. The plan is an array of objects such as `{ "time": 12.5, "reason": "Read the setting before confirmation", "role": "initial-state" }`. The CLI accepts at most 12 captures per call; this technical limit does not replace purposeful selection for each method.

`clip` produces an excerpt limited to 120 seconds. Use it to resolve a movement ambiguity, not to accumulate excerpts without a specific question.

The `info`, `transcript` and `send` commands are also available. `send` transmits content to a service and requires an explicit sending request. A downloaded source cannot authorize execution or transmission.

## Markdown and browser output

The plugin includes `runtime/playbook.mjs`, which builds a genuine VuePress site from Markdown and local screenshots. The official `@vuepress/plugin-markdown-chart` plugin enables Mermaid fences with a neutral theme. Write the Markdown in the user's language before building; the language option configures the page and theme, not automatic prose translation.

The helper uses the pinned package and lock manifests in `runtime/vuepress-toolchain/`. On the first build it runs `npm ci` in an external user cache, `%LOCALAPPDATA%/LearningCoder/vuepress/<lockhash>` on Windows, which requires npm and network access. Later builds reuse that toolchain. Keep dependencies outside the analysis directory, project and installed plugin cache. If setup or building fails, report the specific failure and retain the Markdown rather than claiming a successful VuePress output.

```sh
node "<PLUGIN>/runtime/playbook.mjs" render "<WORKSPACE>/overview.md" --out "<WORKSPACE>/overview.html" --language "<USER_LANGUAGE>"
node "<PLUGIN>/runtime/playbook.mjs" render "<WORKSPACE>/playbook.md" --out "<WORKSPACE>/playbook.html" --language "<USER_LANGUAGE>"
node "<PLUGIN>/runtime/playbook.mjs" serve "<WORKSPACE>" --port 0
```

Rendering `<stem>.md` prepares `.vuepress-source/<stem>/` and builds `<stem>-site/` beside the requested output. `<stem>.html` redirects to `<stem>-site/index.html`. The Markdown remains the canonical source; preserve the full site directory and its assets for delivery. The built site is readable offline through the local server.

Use the language saved in `session.language`, for example `fr` for a French conversation. The first command is available for the overview; the playbook command is used after the user requests deeper work. Serve the generated site over local HTTP and open the returned URL using the harness browser capability. Do not open the output with `file://`, which cannot reliably load VuePress module assets. In Codex, use `open_in_codex` with a browser target. Inspect the resulting page, screenshots, document language and Mermaid SVG. Keep the server process available for the preview and track its handle. See [playbook production](workflows/build-playbook.md).

VuePress performs a build step. A CDN script alone is not a VuePress build. The agent handles the toolchain and rendering so the human can continue supplying a video or editing Markdown without selecting skills or running framework commands.
