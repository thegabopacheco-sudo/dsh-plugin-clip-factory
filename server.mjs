#!/usr/bin/env node
// dsh-plugin-clip-factory — convierte videos largos en clips cortos y
// verticales 9:16 con ffmpeg local para DeepSeek Harness.
//
// Tools: status, probe, split, shorts, list_clips.
// El agente solo elige operaciones y parámetros validados; los binarios y las
// rutas permitidas se declaran en <DSH_HOME>/clip-factory/config.json.
//
// Seguridad: lectura por defecto, DSH_CLIPS_MODE=read-only deshabilita toda
// escritura, allowedPaths limita entradas y salidas, nunca se sobrescribe un
// archivo existente, rate limit de operaciones pesadas y auditoría JSONL.

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const VERSION = '0.1.0';
const SLUG = 'clip-factory';
const SERVER_NAME = 'clips';
const DSH_HOME = (() => {
  const fromEnv = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.dsh');
})();
const CONFIG_FILE = path.join(DSH_HOME, SLUG, 'config.json');
const OUT_DIR = path.join(DSH_HOME, 'cache', SLUG);
const AUDIT_FILE = path.join(OUT_DIR, 'audit.jsonl');
const READ_ONLY = ['DSH_CLIPS_MODE', 'DSH_CLIP_FACTORY_MODE']
  .some((name) => String(process.env[name] || '').toLowerCase() === 'read-only');
const PROCESS_TIMEOUT_MS = 7 * 60 * 1000;
const HEAVY_RATE_LIMIT = 6;
const HEAVY_RATE_WINDOW_MS = 60_000;
const MAX_CLIPS = 20;
const MAX_SHORTS = 10;
const OUTPUT_MAX_CHARS = 20_000;
const HEAVY_TOOLS = new Set(['split', 'shorts']);
const TIME_PATTERN = /^\d{1,3}(\.\d+)?$|^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/;
const VIDEO_EXTENSION = /\.(mp4|mkv|mov|webm|avi|m4v|gif)$/i;

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function audit(entry) {
  try {
    mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* auditoría best-effort */
  }
}

function loadConfig() {
  let config = {};
  try {
    if (existsSync(CONFIG_FILE)) config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (error) {
    log(`config inválida en ${CONFIG_FILE}: ${error.message}`);
  }
  const defaultProfile = process.env.USERPROFILE || os.homedir();
  const allowedPaths = Array.isArray(config.allowedPaths) && config.allowedPaths.length > 0
    ? config.allowedPaths.map((value) => path.resolve(String(value)))
    : [path.resolve(defaultProfile)];
  const pickBinary = (envNames, configValue, fallback) => {
    for (const name of envNames) {
      const fromEnv = process.env[name] && process.env[name].trim();
      if (fromEnv) return fromEnv;
    }
    if (typeof configValue === 'string' && configValue.trim()) return configValue.trim();
    return fallback;
  };
  return {
    allowedPaths,
    ffmpegPath: pickBinary(['DSH_CLIPS_FFMPEG_PATH', 'DSH_FFMPEG_PATH'], config.ffmpegPath, 'ffmpeg'),
    ffprobePath: pickBinary(['DSH_CLIPS_FFPROBE_PATH', 'DSH_FFPROBE_PATH'], config.ffprobePath, 'ffprobe'),
    configPath: CONFIG_FILE,
  };
}

function ensureAllowed(config, absolutePath) {
  const normalized = path.resolve(absolutePath);
  const lower = normalized.toLowerCase();
  const outsideDir = OUT_DIR.toLowerCase();
  const allowed = config.allowedPaths.some((root) => {
    const rootLower = root.toLowerCase();
    return lower === rootLower || lower.startsWith(rootLower + path.sep) || lower.startsWith(rootLower + '/');
  }) || lower === outsideDir || lower.startsWith(outsideDir + path.sep);
  if (!allowed) {
    throw new Error(`ruta no permitida: ${normalized}. Configura allowedPaths en ${CONFIG_FILE} (actual: ${config.allowedPaths.join(', ')})`);
  }
  return normalized;
}

function resolveInput(config, filePath) {
  if (!filePath || !String(filePath).trim()) throw new Error('falta la ruta de entrada');
  const absolute = path.resolve(String(filePath).trim());
  if (!existsSync(absolute)) throw new Error(`el archivo no existe: ${absolute}`);
  if (!statSync(absolute).isFile()) throw new Error(`la ruta no es un archivo: ${absolute}`);
  ensureAllowed(config, absolute);
  return absolute;
}

function resolveOutputDir(config, directory) {
  const target = directory && String(directory).trim()
    ? ensureAllowed(config, path.resolve(String(directory).trim()))
    : OUT_DIR;
  if (existsSync(target) && !statSync(target).isDirectory()) {
    throw new Error(`la salida no es un directorio: ${target}`);
  }
  mkdirSync(target, { recursive: true });
  return target;
}

function sanitizeBase(name) {
  const cleaned = String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'clip';
}

// Devuelve una ruta libre: jamás sobrescribe un archivo existente.
function uniqueOutput(directory, baseName, extension) {
  const base = sanitizeBase(baseName);
  let candidate = path.join(directory, `${base}${extension}`);
  if (!existsSync(candidate)) return candidate;
  for (let index = 1; index < 1000; index++) {
    candidate = path.join(directory, `${base}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`no se encontró un nombre libre para ${base}${extension} en ${directory}`);
}

function toSeconds(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} inválido: ${value}`);
    return value;
  }
  const raw = String(value ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const parts = raw.split(':');
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map(Number);
    if (nums.every((item) => Number.isFinite(item) && item >= 0)) {
      if (parts.length === 2) return nums[0] * 60 + nums[1];
      return nums[0] * 3600 + nums[1] * 60 + nums[2];
    }
  }
  throw new Error(`${label} inválido: ${value} (usa segundos o HH:MM:SS)`);
}

function formatSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(1) : '?';
}

function runProcess(executable, args, timeoutMs = PROCESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignora */ }
      reject(new Error(`${path.basename(String(executable))} agotó el tiempo (${Math.round(timeoutMs / 1000)} s)`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`no se pudo ejecutar ${executable}: ${error.message}. Instala ffmpeg o define DSH_CLIPS_FFMPEG_PATH / DSH_CLIPS_FFPROBE_PATH.`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${path.basename(String(executable))} terminó con código ${code}: ${(stderr || stdout).trim().slice(-900)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function probeFile(config, absolutePath) {
  const { stdout } = await runProcess(config.ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absolutePath,
  ], 120_000);
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe devolvió JSON inválido');
  }
  const format = data.format || {};
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video') || null;
  const audio = streams.find((stream) => stream.codec_type === 'audio') || null;
  return { format, streams, video, audio };
}

function resolutionOf(info) {
  return info && info.video ? `${info.video.width}x${info.video.height}` : 'sin video';
}

function fpsOf(info) {
  if (!info || !info.video) return '?';
  const raw = info.video.avg_frame_rate || info.video.r_frame_rate || '';
  if (!raw || raw === '0/0') return '?';
  const [num, den] = raw.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return raw;
  return String(Math.round((num / den) * 100) / 100);
}

function truncateOutput(text) {
  const clean = String(text || '').trim();
  return clean.length > OUTPUT_MAX_CHARS ? `${clean.slice(-OUTPUT_MAX_CHARS)}\n...[recortado]` : clean;
}

const heavyTimestamps = [];
function checkHeavyRate(toolName) {
  if (!HEAVY_TOOLS.has(toolName)) return;
  const now = Date.now();
  while (heavyTimestamps.length > 0 && now - heavyTimestamps[0] > HEAVY_RATE_WINDOW_MS) heavyTimestamps.shift();
  if (heavyTimestamps.length >= HEAVY_RATE_LIMIT) {
    throw new Error(`límite de operaciones pesadas alcanzado (${HEAVY_RATE_LIMIT}/minuto); espera un momento`);
  }
  heavyTimestamps.push(now);
}

function assertWritable() {
  if (READ_ONLY) throw new Error('modo read-only (DSH_CLIPS_MODE=read-only): cortes y shorts deshabilitados');
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

// ---------------------------------------------------------------- MCP
function buildInstructions() {
  const config = loadConfig();
  const lines = [];
  lines.push('Clip Factory: convierte videos largos en clips cortos y verticales 9:16 con ffmpeg local.');
  lines.push('');
  lines.push(`Modo: ${READ_ONLY ? 'read-only (solo lectura)' : 'normal'}.`);
  lines.push(`Rutas permitidas: ${config.allowedPaths.join(', ')}`);
  lines.push(`Salidas por defecto: ${OUT_DIR}`);
  lines.push('');
  lines.push('Herramientas:');
  lines.push('- status: versiones de ffmpeg/ffprobe, rutas y modo.');
  lines.push('- probe: resumen de ffprobe (duración, formato, codecs, resolución, fps).');
  lines.push('- split: corta un video en clips por duración de segmento o por número de clips (con solape opcional).');
  lines.push('- shorts: vertical 1080x1920 (crop|pad) de un video, de un segmento start/end o de una lista de clips.');
  lines.push('- list_clips: lista los clips de una carpeta (por defecto la caché de salida).');
  lines.push('');
  lines.push('Reglas:');
  lines.push('- Mira antes de cortar: usa probe para confirmar duración y resolución.');
  lines.push('- Nunca sobrescribe: si el nombre existe, agrega un sufijo único.');
  lines.push('- Respeta allowedPaths; no leas ni escribas fuera de ella.');
  lines.push('- Cada corte/short queda registrado en audit.jsonl.');
  lines.push('- Operaciones pesadas con rate limit y timeout de 7 minutos.');
  return lines.join('\n');
}

function buildServer() {
  const server = new McpServer(
    { name: 'dsh-plugin-clip-factory', version: VERSION },
    { capabilities: { tools: {} }, instructions: buildInstructions() },
  );

  server.registerTool(
    'status',
    {
      title: 'Estado de Clip Factory',
      description: 'Muestra versiones de ffmpeg/ffprobe, rutas permitidas, directorio de salida y modo (normal|read-only).',
      inputSchema: z.object({}),
    },
    async () => {
      const config = loadConfig();
      const lines = [
        `Plugin: dsh-plugin-clip-factory v${VERSION} (serverName ${SERVER_NAME})`,
        `Config: ${config.configPath}`,
        `Modo: ${READ_ONLY ? 'read-only' : 'normal'}`,
        `Rutas permitidas: ${config.allowedPaths.join(', ')}`,
        `Salidas: ${OUT_DIR}`,
      ];
      for (const [label, executable] of [['ffmpeg', config.ffmpegPath], ['ffprobe', config.ffprobePath]]) {
        try {
          const { stdout } = await runProcess(executable, ['-version'], 15_000);
          lines.push(`${label}: ${stdout.split(/\r?\n/)[0]}`);
        } catch (error) {
          lines.push(`${label}: ERROR — ${errorText(error)}`);
        }
      }
      try {
        const clips = readdirSync(OUT_DIR).filter((name) => VIDEO_EXTENSION.test(name));
        lines.push(`Clips en caché de salida: ${clips.length}`);
      } catch {
        lines.push('Clips en caché de salida: 0');
      }
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'probe',
    {
      title: 'Analizar video',
      description: 'Devuelve un resumen de ffprobe: duración, formato, codecs, resolución, fps y bitrate.',
      inputSchema: z.object({
        path: z.string().min(3).describe('Ruta del video/audio (dentro de allowedPaths).'),
      }),
    },
    async (args) => {
      const config = loadConfig();
      const input = resolveInput(config, args.path);
      const info = await probeFile(config, input);
      const lines = [
        `Archivo: ${path.basename(input)} (${statSync(input).size} bytes)`,
        `Ruta: ${input}`,
        `Duración: ${formatSeconds(info.format.duration)} s · formato: ${info.format.format_name || 'desconocido'}`,
      ];
      if (info.video) {
        lines.push(`Video: ${info.video.codec_name} ${resolutionOf(info)} @ ${fpsOf(info)} fps${info.video.bit_rate ? ` · ${Math.round(Number(info.video.bit_rate) / 1000)} kbps` : ''}`);
      }
      if (info.audio) {
        lines.push(`Audio: ${info.audio.codec_name} ${info.audio.channels || '?'} canales${info.audio.sample_rate ? ` · ${info.audio.sample_rate} Hz` : ''}`);
      }
      if (!info.video && !info.audio) lines.push(`Streams: ${info.streams.length}`);
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'split',
    {
      title: 'Dividir en clips',
      description: 'Corta un video en clips por duración de segmento (duration) o por número de clips (count), con solape opcional. Codec reencode (exacto) o copy (rápido).',
      inputSchema: z.object({
        input: z.string().min(3).describe('Ruta del video de entrada (dentro de allowedPaths).'),
        duration: z.union([z.string().regex(TIME_PATTERN), z.number().positive()]).optional().describe('Duración de cada clip en segundos o HH:MM:SS.'),
        count: z.number().int().min(2).max(MAX_CLIPS).optional().describe('Número de clips (2-20).'),
        overlap: z.union([z.string().regex(TIME_PATTERN), z.number().min(0)]).optional().describe('Solape entre clips en segundos (default 0).'),
        codec: z.enum(['reencode', 'copy']).optional().describe('reencode (default, cortes exactos) o copy (rápido, keyframes).'),
        outputDir: z.string().min(3).optional().describe('Carpeta de salida (dentro de allowedPaths); default caché del plugin.'),
      }),
    },
    async (args) => {
      assertWritable();
      if (args.duration === undefined && args.count === undefined) throw new Error('split requiere duration o count');
      if (args.duration !== undefined && args.count !== undefined) throw new Error('usa duration o count, no ambos');
      const config = loadConfig();
      const input = resolveInput(config, args.input);
      // Las rutas se validan antes de consumir cupo de rate limit: una ruta
      // rechazada no gasta operaciones pesadas.
      const outputDir = resolveOutputDir(config, args.outputDir);
      checkHeavyRate('split');
      const info = await probeFile(config, input);
      const total = Number(info.format.duration);
      if (!Number.isFinite(total) || total <= 0) throw new Error('no se pudo determinar la duración del video de entrada');

      const overlap = args.overlap === undefined ? 0 : toSeconds(args.overlap, 'overlap');
      if (overlap < 0) throw new Error('overlap no puede ser negativo');
      const copy = args.codec === 'copy';
      let segmentLength;
      let count;
      if (args.duration !== undefined) {
        segmentLength = toSeconds(args.duration, 'duration');
        if (!(segmentLength > 0)) throw new Error('duration debe ser mayor que 0');
        if (overlap >= segmentLength) throw new Error('overlap debe ser menor que duration');
        const step = segmentLength - overlap;
        count = Math.floor((total - 1e-6) / step) + 1;
      } else {
        count = Number(args.count);
        segmentLength = (total + (count - 1) * overlap) / count;
        if (!(segmentLength > overlap)) throw new Error('overlap demasiado grande para ese count');
      }
      if (count > MAX_CLIPS) throw new Error(`el plan genera ${count} clips; el máximo es ${MAX_CLIPS}`);

      const step = segmentLength - overlap;
      const plan = [];
      for (let index = 0; index < count; index++) {
        const start = index * step;
        if (start >= total - 0.05) break;
        const end = Math.min(start + segmentLength, total);
        const length = end - start;
        if (length < 0.2) break;
        plan.push({ start, length });
      }
      if (plan.length === 0) throw new Error('el plan no generó clips');

      const baseName = path.basename(input).replace(/\.[^.]+$/, '');
      const codecArgs = copy
        ? ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
        : ['-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
      const results = [];
      for (let index = 0; index < plan.length; index++) {
        const item = plan[index];
        const output = uniqueOutput(outputDir, `${baseName}-clip-${index + 1}`, '.mp4');
        if (path.resolve(output).toLowerCase() === path.resolve(input).toLowerCase()) {
          throw new Error('la salida no puede sobrescribir la entrada');
        }
        await runProcess(config.ffmpegPath, [
          '-y',
          '-ss', item.start.toFixed(3),
          '-i', input,
          '-t', item.length.toFixed(3),
          ...codecArgs,
          output,
        ]);
        let clipInfo = null;
        try {
          clipInfo = await probeFile(config, output);
        } catch {
          /* el clip existe aunque ffprobe falle; se reporta como desconocido */
        }
        results.push({
          path: output,
          duration: clipInfo ? Number(clipInfo.format.duration) : item.length,
          resolution: clipInfo ? resolutionOf(clipInfo) : '?',
          bytes: statSync(output).size,
        });
      }

      audit({
        tool: 'split',
        input: path.basename(input),
        outputDir,
        clips: results.length,
        codec: copy ? 'copy' : 'reencode',
        overlap,
        ok: true,
      });

      const lines = [
        `Entrada: ${path.basename(input)} — ${formatSeconds(total)} s, ${resolutionOf(info)}`,
        `Plan: ${results.length} clips · segmento ${formatSeconds(segmentLength)} s · solape ${formatSeconds(overlap)} s · codec ${copy ? 'copy' : 'reencode'}`,
        `Salida: ${outputDir}`,
      ];
      results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.path} | ${formatSeconds(result.duration)} s | ${result.resolution} | ${result.bytes} bytes`);
      });
      return textResult(truncateOutput(lines.join('\n')));
    },
  );

  server.registerTool(
    'shorts',
    {
      title: 'Shorts verticales 9:16',
      description: 'Genera videos verticales 1080x1920 (crop o pad) desde un video, desde un segmento start/end o desde una lista de clips.',
      inputSchema: z.object({
        input: z.string().min(3).optional().describe('Video de entrada; alternativa a clips.'),
        clips: z.array(z.string().min(3)).max(MAX_SHORTS).optional().describe(`Lista de clips a convertir (máximo ${MAX_SHORTS}).`),
        start: z.union([z.string().regex(TIME_PATTERN), z.number().min(0)]).optional().describe('Inicio del segmento (con input).'),
        end: z.union([z.string().regex(TIME_PATTERN), z.number().positive()]).optional().describe('Fin del segmento (con input).'),
        duration: z.union([z.string().regex(TIME_PATTERN), z.number().positive()]).optional().describe('Duración del segmento desde start (alternativa a end).'),
        mode: z.enum(['crop', 'pad']).optional().describe('crop recorta al centro; pad agrega barras negras (default crop).'),
        outputDir: z.string().min(3).optional().describe('Carpeta de salida (dentro de allowedPaths); default caché del plugin.'),
      }),
    },
    async (args) => {
      assertWritable();
      const hasClips = Array.isArray(args.clips) && args.clips.length > 0;
      if (hasClips && args.input) throw new Error('usa input o clips, no ambos');
      if (!hasClips && !args.input) throw new Error('shorts requiere input o clips');
      if (hasClips && (args.start !== undefined || args.end !== undefined || args.duration !== undefined)) {
        throw new Error('start/end/duration solo aplican a input, no a clips');
      }
      if (args.start !== undefined && args.end === undefined && args.duration === undefined) {
        // recortar desde start hasta el final del video: válido
      }
      const config = loadConfig();
      const mode = args.mode || 'crop';
      const filter = mode === 'crop'
        ? 'crop=floor(ih*9/16/2)*2:ih,scale=1080:1920,setsar=1'
        : 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';

      const sources = [];
      let start = 0;
      let rangeEnd = null;
      if (hasClips) {
        for (const clip of args.clips) sources.push(resolveInput(config, clip));
      } else {
        const input = resolveInput(config, args.input);
        sources.push(input);
        const info = await probeFile(config, input);
        const total = Number(info.format.duration);
        if (!Number.isFinite(total) || total <= 0) throw new Error('no se pudo determinar la duración del video de entrada');
        start = args.start === undefined ? 0 : toSeconds(args.start, 'start');
        if (args.duration !== undefined && args.end !== undefined) throw new Error('usa end o duration, no ambos');
        if (args.duration !== undefined) {
          const clipDuration = toSeconds(args.duration, 'duration');
          if (!(clipDuration > 0)) throw new Error('duration debe ser mayor que 0');
          rangeEnd = Math.min(start + clipDuration, total);
        } else if (args.end !== undefined) {
          rangeEnd = toSeconds(args.end, 'end');
          if (!(rangeEnd > start)) throw new Error('end debe ser mayor que start');
          if (rangeEnd > total) rangeEnd = total;
        } else {
          rangeEnd = total;
        }
        if (start >= total) throw new Error(`start (${start} s) supera la duración del video (${total} s)`);
      }

      const outputDir = resolveOutputDir(config, args.outputDir);
      // Rutas y fuentes validadas antes de consumir cupo de rate limit.
      checkHeavyRate('shorts');
      const results = [];
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        const baseName = path.basename(source).replace(/\.[^.]+$/, '');
        const output = uniqueOutput(outputDir, `${baseName}-short-${index + 1}`, '.mp4');
        const ffArgs = ['-y'];
        if (start > 0) ffArgs.push('-ss', start.toFixed(3));
        ffArgs.push('-i', source);
        if (rangeEnd !== null && Number.isFinite(rangeEnd)) ffArgs.push('-t', (rangeEnd - start).toFixed(3));
        ffArgs.push(
          '-vf', filter,
          '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart',
          output,
        );
        await runProcess(config.ffmpegPath, ffArgs);
        let shortInfo = null;
        try {
          shortInfo = await probeFile(config, output);
        } catch {
          /* se reporta como desconocido */
        }
        results.push({
          path: output,
          duration: shortInfo ? Number(shortInfo.format.duration) : null,
          resolution: shortInfo ? resolutionOf(shortInfo) : '?',
          bytes: statSync(output).size,
        });
      }

      audit({
        tool: 'shorts',
        sources: sources.map((source) => path.basename(source)),
        outputDir,
        mode,
        clips: results.length,
        ok: true,
      });

      const lines = [
        `Shorts verticales 1080x1920 (${mode}): ${results.length}`,
        `Salida: ${outputDir}`,
      ];
      results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.path} | ${result.duration === null ? '?' : formatSeconds(result.duration)} s | ${result.resolution} | ${result.bytes} bytes`);
      });
      return textResult(truncateOutput(lines.join('\n')));
    },
  );

  server.registerTool(
    'list_clips',
    {
      title: 'Listar clips',
      description: 'Lista los clips de video de una carpeta (por defecto la caché de salida) con duración, resolución y tamaño. Operación de solo lectura.',
      inputSchema: z.object({
        directory: z.string().min(3).optional().describe('Carpeta a listar (dentro de allowedPaths); default caché del plugin.'),
        limit: z.number().int().min(1).max(100).optional().describe('Máximo de clips a mostrar (default 20).'),
      }),
    },
    async (args) => {
      const config = loadConfig();
      const directory = args.directory && String(args.directory).trim()
        ? ensureAllowed(config, path.resolve(String(args.directory).trim()))
        : OUT_DIR;
      const limit = args.limit === undefined ? 20 : args.limit;
      if (!existsSync(directory)) {
        return textResult(`Directorio: ${directory}\nNo existe todavía (aún no se generaron clips).`);
      }
      if (!statSync(directory).isDirectory()) throw new Error(`la ruta no es un directorio: ${directory}`);
      const files = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && VIDEO_EXTENSION.test(entry.name))
        .map((entry) => {
          const absolute = path.join(directory, entry.name);
          const stat = statSync(absolute);
          return { name: entry.name, path: absolute, mtimeMs: stat.mtimeMs, bytes: stat.size };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
      const shown = files.slice(0, limit);
      const lines = [`Directorio: ${directory}`, `Archivos de video: ${files.length} (mostrando ${shown.length})`];
      for (let index = 0; index < shown.length; index++) {
        const file = shown[index];
        let duration = '?';
        let resolution = '?';
        try {
          const info = await probeFile(config, file.path);
          duration = formatSeconds(info.format.duration);
          resolution = resolutionOf(info);
        } catch {
          /* si ffprobe falla se muestra "?" */
        }
        lines.push(`${index + 1}. ${file.path} | ${duration} s | ${resolution} | ${file.bytes} bytes`);
      }
      return textResult(truncateOutput(lines.join('\n')));
    },
  );

  return server;
}

try {
  mkdirSync(OUT_DIR, { recursive: true });
} catch {
  /* ignora */
}
log(`modo ${READ_ONLY ? 'read-only' : 'normal'} · allowedPaths: ${loadConfig().allowedPaths.join(', ')}`);

serveStdio(buildServer, { onerror: (error) => log(`serveStdio: ${error.message}`) });

process.on('uncaughtException', (error) => log(`excepción no atrapada: ${error.message}`));
process.on('unhandledRejection', (error) => log(`rechazo no manejado: ${error && error.message ? error.message : String(error)}`));
