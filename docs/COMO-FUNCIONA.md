# Cómo funciona dsh-plugin-clip-factory

Clip Factory convierte videos largos en clips cortos y verticales 9:16 para Shorts/Reels/TikTok usando el ffmpeg local del equipo. No usa red ni servicios externos.

## Arquitectura

```
DSH ──MCP stdio──► server.mjs (bundle single-file)
                    ├─ status / probe / list_clips   (solo lectura)
                    ├─ split                         (escritura)
                    └─ shorts                        (escritura)
                          └─ spawn(ffmpeg | ffprobe)
```

- `server.mjs` es el runtime que se despliega en `<DSH_HOME>\plugins\clip-factory\server.mjs`.
- Cada tool valida rutas, parámetros y modo antes de ejecutar binarios.
- `ffmpeg` y `ffprobe` se leen de `PATH` o de `config.json` / variables de entorno.

## Herramientas

### status
Versiones de ffmpeg/ffprobe, config, modo, rutas permitidas, caché de salida y cantidad de clips en caché.

### probe
Ejecuta `ffprobe -show_format -show_streams` y resume duración, formato, códec de video/audio, resolución, fps y bitrate. Todas las entradas pasan por `allowedPaths`.

### split
1. Valida la entrada y hace probe para conocer la duración total.
2. Si recibe `duration`: el segmento mide `duration` segundos y el solape resta al paso. El número de clips se deriva del total.
3. Si recibe `count`: el largo del segmento se calcula para cubrir el video completo: `L = (total + (count-1)*overlap) / count`.
4. Cada clip se genera con ffmpeg (`-ss` antes de `-i` + `-t`), con `reencode` (libx264 + aac, exacto) o `copy` (rápido, corta en keyframes).
5. Los archivos se nombran `<video>-clip-N.mp4` y un sufijo numérico evita sobrescribir.
6. Cada salida se re-verifica con ffprobe y se reporta duración, resolución y bytes.

### shorts
- Fuente única (`input`) con recorte opcional `start` + `end`/`duration`, o lista de `clips`.
- Filtro `crop`: recorta el centro a 9:16 y escala a 1080x1920.
- Filtro `pad`: escala manteniendo proporción y agrega barras negras hasta 1080x1920.
- Salida mp4 H.264 + AAC con faststart; nombres `<clip>-short-N.mp4` sin sobrescribir.

### list_clips
Lista archivos de video de una carpeta permitida (por defecto la caché), ordenados por fecha de modificación, con duración y resolución vía ffprobe. Es de solo lectura.

## Herramientas reales

- `status`: Estado de Clip Factory
- `probe`: Analizar video
- `split`: Dividir en clips
- `shorts`: Shorts verticales 9:16
- `list_clips`: Listar clips

## Seguridad

- **allowedPaths**: raíces permitidas para lectura y escritura; la caché del plugin siempre está permitida. Sin coincidencia se rechaza antes de tocar el disco.
- **Read-only**: `DSH_CLIPS_MODE=read-only` bloquea `split` y `shorts`; las tools de lectura siguen funcionando.
- **Sin sobrescritura**: `uniqueOutput` busca un nombre libre; la salida nunca puede ser la entrada.
- **Rate limit**: 6 operaciones pesadas (`split`, `shorts`) por minuto.
- **Timeout**: 7 minutos por proceso ffmpeg/ffprobe.
- **Auditoría**: cada `split`/`shorts` exitoso se agrega a `<DSH_HOME>\cache\clip-factory\audit.jsonl`.

## Configuración

```json
{
  "allowedPaths": ["C:\\Users\\tu-usuario"],
  "ffmpegPath": "",
  "ffprobePath": ""
}
```

`ffmpegPath`/`ffprobePath` vacíos usan `PATH`; también aplican `DSH_CLIPS_FFMPEG_PATH` y `DSH_CLIPS_FFPROBE_PATH`.

## Verificación

Tests end-to-end con el cliente MCP oficial (`@modelcontextprotocol/client@2.2.0`) y artefacto empaquetado (`npm pack` → `postinstall` → servidor desplegado). El test genera un video `testsrc` de 9 s, prueba split por duración y por número de clips con solape, no-sobrescritura, shorts 1080x1920 desde input y desde clips, list_clips, rechazo de rutas fuera de `allowedPaths` y modo read-only.
