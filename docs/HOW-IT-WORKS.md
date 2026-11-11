# How dsh-plugin-clip-factory works

Clip Factory turns long videos into short and vertical 9:16 clips for Shorts/Reels/TikTok using the local ffmpeg. No network or external services are used.

## Architecture

```
DSH ──MCP stdio──► server.mjs (single-file bundle)
                    ├─ status / probe / list_clips   (read-only)
                    ├─ split                         (writes)
                    └─ shorts                        (writes)
                          └─ spawn(ffmpeg | ffprobe)
```

- `server.mjs` is the runtime deployed at `<DSH_HOME>\plugins\clip-factory\server.mjs`.
- Every tool validates paths, arguments and mode before running binaries.
- `ffmpeg` and `ffprobe` come from `PATH` or from `config.json` / environment variables.

## Tools

### status
ffmpeg/ffprobe versions, config path, mode, allowed paths, output cache and cached clip count.

### probe
Runs `ffprobe -show_format -show_streams` and summarizes duration, format, video/audio codec, resolution, fps and bitrate. All inputs go through `allowedPaths`.

### split
1. Validates the input and probes it for total duration.
2. With `duration`: each segment lasts `duration` seconds; overlap is subtracted from the step; clip count follows from the total.
3. With `count`: segment length covers the whole video: `L = (total + (count-1)*overlap) / count`.
4. Each clip is produced by ffmpeg (`-ss` before `-i` plus `-t`), using `reencode` (libx264 + aac, accurate) or `copy` (fast, keyframe cuts).
5. Files are named `<video>-clip-N.mp4`; a numeric suffix prevents overwriting.
6. Every output is re-probed and reported with duration, resolution and bytes.

### shorts
- Single source (`input`) with optional `start` + `end`/`duration` trim, or a list of `clips`.
- `crop`: center-crops to 9:16 and scales to 1080x1920.
- `pad`: scales preserving aspect ratio and pads with black bars to 1080x1920.
- Output is H.264 + AAC mp4 with faststart; names `<clip>-short-N.mp4` without overwriting.

### list_clips
Lists video files in an allowed folder (cache by default), ordered by modification time, with duration and resolution via ffprobe. Read-only.

## Safety

- **allowedPaths**: allowed roots for reads/writes; the plugin cache is always allowed. Non-matching paths are rejected before touching disk.
- **Read-only**: `DSH_CLIPS_MODE=read-only` blocks `split` and `shorts`; read tools keep working.
- **No overwrite**: `uniqueOutput` finds a free name; output can never be the input.
- **Rate limit**: 6 heavy operations (`split`, `shorts`) per minute.
- **Timeout**: 7 minutes per ffmpeg/ffprobe process.
- **Audit**: every successful `split`/`shorts` is appended to `<DSH_HOME>\cache\clip-factory\audit.jsonl`.

## Configuration

```json
{
  "allowedPaths": ["C:\\Users\\your-user"],
  "ffmpegPath": "",
  "ffprobePath": ""
}
```

Empty `ffmpegPath`/`ffprobePath` use `PATH`; `DSH_CLIPS_FFMPEG_PATH` and `DSH_CLIPS_FFPROBE_PATH` also apply.

## Validation

End-to-end tests with the official MCP client (`@modelcontextprotocol/client@2.2.0`) and the packaged artifact (`npm pack` → `postinstall` → deployed server). The test generates a 9-second `testsrc` video and covers split by duration and by count with overlap, no-overwrite behavior, 1080x1920 shorts from input and from clips, list_clips, rejection of paths outside `allowedPaths` and read-only mode.
