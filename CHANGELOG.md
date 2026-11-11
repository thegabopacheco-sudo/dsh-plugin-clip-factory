# Changelog

## 0.1.0 — 2026-11-11

- Primera versión pública de dsh-plugin-clip-factory: convierte videos largos en clips cortos y verticales 9:16 con ffmpeg local para DeepSeek Harness.
- Tools: `status`, `probe`, `split` (por duración o número de clips con solape, reencode o copy), `shorts` (1080x1920 crop/pad desde input o clips), `list_clips`.
- allowedPaths, salida por defecto en `<DSH_HOME>\cache\clip-factory`, modo read-only (`DSH_CLIPS_MODE`), rate limit, timeouts y auditoría JSONL.
