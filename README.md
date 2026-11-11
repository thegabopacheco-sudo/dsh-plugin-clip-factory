# dsh-plugin-clip-factory — Clip Factory

Convierte videos largos en clips cortos y verticales 9:16 con ffmpeg local para DeepSeek Harness.

Expone el servidor MCP `clips`: las tools aparecen como `mcp__clips__*`.

## Herramientas

| Tool | Qué hace |
|---|---|
| `status` | Estado de Clip Factory |
| `probe` | Analizar video |
| `split` | Dividir en clips |
| `shorts` | Shorts verticales 9:16 |
| `list_clips` | Listar clips |

## Configuración

Archivo: `<DSH_HOME>\clip-factory\config.json` (ver `config.example.json`).

```json
{
  "allowedPaths": ["C:\\Users\\tu-usuario"],
  "ffmpegPath": "",
  "ffprobePath": ""
}
```

- `allowedPaths`: raíces de archivos que el plugin puede leer y escribir. La caché de salida siempre está permitida.
- `ffmpegPath` / `ffprobePath` vacíos usan los binarios del `PATH`. También puedes usar `DSH_CLIPS_FFMPEG_PATH` / `DSH_CLIPS_FFPROBE_PATH`.
- Salidas por defecto: `<DSH_HOME>\cache\clip-factory`.

## Seguridad

- Lectura por defecto; `split` y `shorts` escriben solo dentro de `allowedPaths` o de la caché.
- `DSH_CLIPS_MODE=read-only` bloquea todas las escrituras (`split`, `shorts`) y deja `status`, `probe` y `list_clips` disponibles.
- Nunca sobrescribe: si el nombre existe agrega un sufijo único; la salida jamás puede ser la entrada.
- Rate limit de 6 operaciones pesadas por minuto y timeout de 7 minutos por proceso ffmpeg/ffprobe.
- Auditoría en `<DSH_HOME>\cache\clip-factory\audit.jsonl`.

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-clip-factory` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-clip-factory
```

## Verificación

`test\connect-test.mjs` genera un video `testsrc` con ffmpeg y prueba de extremo a extremo: status, probe, split por duración y por número de clips con solape, no-sobrescritura, shorts desde input y desde clips, list_clips, rutas fuera de `allowedPaths` y modo read-only.

```
cd dsh-plugin-clip-factory
npm install
npm run build:bundle
node test/connect-test.mjs
```

## Licencia

MIT © thegabopacheco-sudo
