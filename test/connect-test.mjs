// Prueba end-to-end de dsh-plugin-clip-factory con ffmpeg local.
// Genera un video de prueba con testsrc, corta clips, genera shorts 9:16,
// lista salidas, verifica duraciones/resolución con probe y comprueba
// seguridad (rutas fuera de allowedPaths y modo read-only).
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDir = path.resolve(import.meta.dirname, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
rmSync(tmpDir, { recursive: true, force: true });
const dshHome = path.join(tmpDir, 'dsh-home');
mkdirSync(path.join(dshHome, 'clip-factory'), { recursive: true });
writeFileSync(path.join(dshHome, 'clip-factory', 'config.json'), JSON.stringify({
  allowedPaths: [tmpDir],
  ffmpegPath: '',
  ffprobePath: '',
}, null, 2), 'utf8');

const sample = path.join(tmpDir, 'sample.mp4');
console.log('generando video de prueba (testsrc 320x240, 9 s)...');
execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=9',
  '-pix_fmt', 'yuv420p', sample,
], { stdio: 'ignore' });
console.log('sample:', statSync(sample).size, 'bytes');

let failures = 0;
let checks = 0;
function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`[bien] ${name}`);
  } else {
    failures++;
    console.error(`[fallo] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function textOf(result) {
  return (result.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

function parseEntries(text) {
  const entries = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\d+\. (.+?) \| ([\d.]+) s \| (.+?) \| (\d+) bytes$/);
    if (match) {
      entries.push({
        path: match[1],
        duration: Number(match[2]),
        resolution: match[3],
        bytes: Number(match[4]),
      });
    }
  }
  return entries;
}

function makeClient(extraEnv = {}) {
  const serverEntry = process.env.CLIPS_SERVER
    ? path.resolve(process.env.CLIPS_SERVER)
    : path.join(packageDir, 'server.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: process.env.PATH,
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME || process.env.USERPROFILE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      DSH_HOME: dshHome,
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const client = new Client(
    { name: 'clip-factory-test', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  return client.connect(transport).then(() => ({ client, transport }));
}

async function call(instance, name, args) {
  const result = await instance.client.callTool({ name, arguments: args });
  return { result, text: textOf(result), isError: result.isError === true };
}

async function closeClient(instance) {
  if (!instance) return;
  try { await instance.client.close(); } catch { /* ya cerrado */ }
  try { await instance.transport.close?.(); } catch { /* ya cerrado */ }
}

let normal = null;
let readonly = null;
try {
  normal = await makeClient();

  const tools = await normal.client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const required of ['status', 'probe', 'split', 'shorts', 'list_clips']) {
    check(`tool ${required} registrada`, toolNames.includes(required), toolNames.join(', '));
  }

  // ---------------------------------------------------------------- status
  const status = await call(normal, 'status', {});
  console.log('--- status ---');
  console.log(status.text);
  check('status ok', !status.isError);
  check('status reporta ffmpeg', /ffmpeg: .*ffmpeg version/i.test(status.text), status.text);
  check('status reporta ffprobe', /ffprobe: .*ffprobe version/i.test(status.text));
  check('status modo normal', status.text.includes('Modo: normal'));
  check('status allowedPaths', status.text.includes(tmpDir));

  // ---------------------------------------------------------------- probe
  const probe = await call(normal, 'probe', { path: sample });
  console.log('--- probe sample ---');
  console.log(probe.text);
  check('probe ok', !probe.isError);
  check('probe duración 9 s', /Duración: 9\.0 s/.test(probe.text), probe.text);
  check('probe resolución 320x240', probe.text.includes('320x240'));

  // ------------------------------------------------- split por duración
  const split1 = await call(normal, 'split', { input: sample, duration: '3' });
  console.log('--- split duration 3 ---');
  console.log(split1.text);
  check('split duration ok', !split1.isError, split1.text.slice(0, 200));
  check('split duration plan 3 clips', /Plan: 3 clips/.test(split1.text));
  const clips1 = parseEntries(split1.text);
  check('split duration 3 salidas', clips1.length === 3, JSON.stringify(clips1.map((clip) => path.basename(clip.path))));
  for (const clip of clips1) {
    check(`clip ${path.basename(clip.path)} existe`, existsSync(clip.path) && statSync(clip.path).size > 0);
    check(`clip ${path.basename(clip.path)} duración ~3 s`, clip.duration >= 2.4 && clip.duration <= 3.6, String(clip.duration));
    check(`clip ${path.basename(clip.path)} resolución 320x240`, clip.resolution === '320x240', clip.resolution);
  }
  const cacheDir = path.join(dshHome, 'cache', 'clip-factory');
  check('split usa la caché de salida por defecto',
    clips1.length > 0 && path.dirname(clips1[0].path).toLowerCase() === cacheDir.toLowerCase(),
    clips1[0]?.path);
  const probeClip1 = await call(normal, 'probe', { path: clips1[0].path });
  check('probe verifica clip del split', /Duración: 3\.0 s/.test(probeClip1.text) && probeClip1.text.includes('320x240'), probeClip1.text);

  // ---------------------------------------------- split por count + solape
  const countDir = path.join(tmpDir, 'count-clips');
  const split2 = await call(normal, 'split', { input: sample, count: 2, overlap: '1', outputDir: countDir });
  console.log('--- split count 2 overlap 1 ---');
  console.log(split2.text);
  check('split count ok', !split2.isError, split2.text.slice(0, 200));
  const clips2 = parseEntries(split2.text);
  check('split count 2 salidas', clips2.length === 2);
  check('split count duración ~5 s', clips2.every((clip) => clip.duration >= 4.4 && clip.duration <= 5.6),
    JSON.stringify(clips2.map((clip) => clip.duration)));

  // ------------------------------------------------------- sin sobrescribir
  const split3 = await call(normal, 'split', { input: sample, count: 2, overlap: '1', outputDir: countDir });
  const clips3 = parseEntries(split3.text);
  check('split reejecutado ok', !split3.isError);
  check('split no sobrescribe (nombres nuevos)',
    clips3.length === 2 && clips3.every((clip) => !clips2.some((prev) => prev.path.toLowerCase() === clip.path.toLowerCase())),
    clips3.map((clip) => path.basename(clip.path)).join(', '));
  check('split no sobrescribe (4 archivos)', readdirSync(countDir).filter((name) => /\.mp4$/i.test(name)).length === 4);

  // --------------------------------------------------- split con codec copy
  const copyDir = path.join(tmpDir, 'copy-clips');
  const splitCopy = await call(normal, 'split', { input: sample, duration: '3', codec: 'copy', outputDir: copyDir });
  console.log('--- split codec copy ---');
  console.log(splitCopy.text);
  check('split copy ok', !splitCopy.isError, splitCopy.text.slice(0, 200));
  const clipsCopy = parseEntries(splitCopy.text);
  check('split copy 3 salidas', clipsCopy.length === 3, String(clipsCopy.length));
  check('split copy archivos válidos', clipsCopy.every((clip) => existsSync(clip.path) && clip.bytes > 0));

  // ------------------------------------------------- shorts desde input
  const shortsDir = path.join(tmpDir, 'shorts');
  const shorts1 = await call(normal, 'shorts', { input: sample, start: '0', end: '4', mode: 'crop', outputDir: shortsDir });
  console.log('--- shorts input 0-4 crop ---');
  console.log(shorts1.text);
  check('shorts input ok', !shorts1.isError, shorts1.text.slice(0, 200));
  const shorts1Entries = parseEntries(shorts1.text);
  check('shorts input 1 salida', shorts1Entries.length === 1);
  check('shorts input 1080x1920', shorts1Entries[0]?.resolution === '1080x1920', shorts1Entries[0]?.resolution);
  check('shorts input duración ~4 s', shorts1Entries[0]?.duration >= 3.4 && shorts1Entries[0]?.duration <= 4.6, String(shorts1Entries[0]?.duration));
  const shortsProbe = await call(normal, 'probe', { path: shorts1Entries[0].path });
  check('probe verifica short 1080x1920', /Video: \S+ 1080x1920/.test(shortsProbe.text), shortsProbe.text);

  // ------------------------------------------------- shorts desde clips
  const fromClipsDir = path.join(tmpDir, 'shorts-from-clips');
  const shorts2 = await call(normal, 'shorts', { clips: clips2.map((clip) => clip.path), mode: 'pad', outputDir: fromClipsDir });
  console.log('--- shorts desde 2 clips pad ---');
  console.log(shorts2.text);
  check('shorts desde clips ok', !shorts2.isError, shorts2.text.slice(0, 200));
  const shorts2Entries = parseEntries(shorts2.text);
  check('shorts desde clips 2 salidas', shorts2Entries.length === 2);
  check('shorts desde clips 1080x1920', shorts2Entries.every((entry) => entry.resolution === '1080x1920'),
    JSON.stringify(shorts2Entries.map((entry) => entry.resolution)));

  // ----------------------------------------------------------- list_clips
  const listDefault = await call(normal, 'list_clips', {});
  console.log('--- list_clips default ---');
  console.log(listDefault.text);
  check('list_clips default ok', !listDefault.isError);
  check('list_clips default 3 clips', /Archivos de video: 3/.test(listDefault.text), listDefault.text.slice(0, 200));
  const listDir = await call(normal, 'list_clips', { directory: countDir });
  console.log('--- list_clips countDir ---');
  console.log(listDir.text);
  check('list_clips carpeta ok', !listDir.isError);
  check('list_clips 4 clips', /Archivos de video: 4/.test(listDir.text), listDir.text.slice(0, 200));
  check('list_clips muestra nombres', /sample-clip-1\.mp4/.test(listDir.text));

  // ------------------------------------------------------------- seguridad
  const outsideFile = path.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe');
  const outsideProbe = await call(normal, 'probe', { path: outsideFile });
  check('probe fuera de allowedPaths bloqueado', outsideProbe.isError && /ruta no permitida/.test(outsideProbe.text), outsideProbe.text.slice(0, 160));
  const outsideDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'dsh-clip-factory-no-existe');
  const outsideSplit = await call(normal, 'split', { input: sample, duration: '3', outputDir: outsideDir });
  check('split fuera de allowedPaths bloqueado', outsideSplit.isError && /ruta no permitida/.test(outsideSplit.text), outsideSplit.text.slice(0, 160));
  check('split fuera no crea carpeta', !existsSync(outsideDir));
  const missing = await call(normal, 'probe', { path: path.join(tmpDir, 'no-existe.mp4') });
  check('probe archivo inexistente bloqueado', missing.isError && /no existe/.test(missing.text), missing.text.slice(0, 160));
  const outsideList = await call(normal, 'list_clips', { directory: path.join(process.env.SystemRoot || 'C:\\Windows') });
  check('list_clips fuera de allowedPaths bloqueado', outsideList.isError && /ruta no permitida/.test(outsideList.text));

  await closeClient(normal);
  normal = null;

  // ------------------------------------------------------------ read-only
  readonly = await makeClient({ DSH_CLIPS_MODE: 'read-only' });
  const roStatus = await call(readonly, 'status', {});
  console.log('--- status read-only ---');
  console.log(roStatus.text);
  check('status read-only', roStatus.text.includes('Modo: read-only'), roStatus.text);
  const roSplit = await call(readonly, 'split', { input: sample, duration: '3' });
  check('split read-only bloqueado', roSplit.isError && /read-only/.test(roSplit.text), roSplit.text.slice(0, 160));
  const roShorts = await call(readonly, 'shorts', { input: sample, mode: 'crop' });
  check('shorts read-only bloqueado', roShorts.isError && /read-only/.test(roShorts.text), roShorts.text.slice(0, 160));
  const roList = await call(readonly, 'list_clips', {});
  check('list_clips funciona en read-only', !roList.isError && /Archivos de video: 3/.test(roList.text));
  const roProbe = await call(readonly, 'probe', { path: sample });
  check('probe funciona en read-only', !roProbe.isError && /Duración: 9\.0 s/.test(roProbe.text));

  // --------------------------------------------------------------- auditoría
  const auditFile = path.join(cacheDir, 'audit.jsonl');
  check('audit.jsonl existe', existsSync(auditFile));
  const auditLines = existsSync(auditFile) ? readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  check('audit.jsonl registra operaciones', auditLines.length >= 5, `${auditLines.length} entradas`);
} catch (error) {
  failures++;
  console.error('[fallo] excepción:', error && error.stack ? error.stack : error);
} finally {
  await closeClient(normal);
  await closeClient(readonly);
}

console.log(`comprobaciones: ${checks} · fallos: ${failures}`);
if (failures > 0) {
  console.error(`TEST FALLIDO: ${failures} fallos`);
  process.exit(1);
}
console.log('OK');
