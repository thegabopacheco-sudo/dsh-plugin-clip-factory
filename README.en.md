# dsh-plugin-clip-factory — Clip Factory

Turns long videos into short and vertical 9:16 clips with local ffmpeg for DeepSeek Harness.

Exposes the MCP server `clips`: tools show up as `mcp__clips__*`.

## Tools

| Tool | Qué hace |
|---|---|
| `status` | Estado de Clip Factory |
| `probe` | Analizar video |
| `split` | Dividir en clips |
| `shorts` | Shorts verticales 9:16 |
| `list_clips` | Listar clips |

## Configuration

File: `<DSH_HOME>\clip-factory\config.json` (see `config.example.json`).

- `allowedPaths`: roots the plugin may read/write. The output cache is always allowed.
- Empty `ffmpegPath` / `ffprobePath` use PATH binaries. `DSH_CLIPS_FFMPEG_PATH` / `DSH_CLIPS_FFPROBE_PATH` also work.
- Default outputs: `<DSH_HOME>\cache\clip-factory`.

## Safety

- Read by default; `split` and `shorts` only write inside `allowedPaths` or the cache.
- `DSH_CLIPS_MODE=read-only` blocks all writes (`split`, `shorts`) while `status`, `probe` and `list_clips` stay available.
- Never overwrites: existing names get a unique suffix; output can never be the input.
- Rate limit of 6 heavy operations per minute and 7-minute timeout per ffmpeg/ffprobe process.
- Audit log at `<DSH_HOME>\cache\clip-factory\audit.jsonl`.

## Install

From **DSH → Settings → Plugins** install `github:thegabopacheco-sudo/dsh-plugin-clip-factory` and allow the install script.

```
dsh plugin --profile <profile> add github:thegabopacheco-sudo/dsh-plugin-clip-factory
```

## Validation

`test\connect-test.mjs` generates a `testsrc` video with ffmpeg and runs end-to-end tests: status, probe, split by duration and by clip count with overlap, no-overwrite behavior, shorts from input and from clips, list_clips, paths outside `allowedPaths` and read-only mode.

```
cd dsh-plugin-clip-factory
npm install
npm run build:bundle
node test/connect-test.mjs
```

## License

MIT © thegabopacheco-sudo
