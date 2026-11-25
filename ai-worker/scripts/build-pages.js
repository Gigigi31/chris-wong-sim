import { readFile, mkdir, readdir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const defaultOutput = fileURLToPath(new URL('../pages-dist/', import.meta.url));
const baselinePath = new URL('../test/fixtures/frontend-baseline.json', import.meta.url);
const sha256 = text => createHash('sha256').update(text).digest('hex');

export async function sourceAndBaseline() {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const html = await readFile(path.join(root, baseline.source), 'utf8');
  return { html, baseline };
}

export function inspectFrontend(html, baseline) {
  let restored = html;
  let protectedSource = html;
  const blocks = {};
  for (const name of ['AI_CONFIG', 'aiEnabled', 'fetch']) {
    const pattern = new RegExp(baseline.patterns[name], 'g');
    const matches = [...html.matchAll(pattern)];
    if (matches.length !== 1) throw new Error('Frontend boundary check failed');
    blocks[name] = matches[0][0];
    restored = restored.replace(new RegExp(baseline.patterns[name]), () => baseline.originalBlocks[name]);
    protectedSource = protectedSource.replace(new RegExp(baseline.patterns[name]), () => `<ALLOWED:${name}>`);
  }
  if (sha256(restored) !== baseline.originalSha256 || sha256(protectedSource) !== baseline.protectedSha256) {
    throw new Error('Protected frontend content changed');
  }
  const config = vm.runInNewContext(`${blocks.AI_CONFIG}\nAI_CONFIG`, Object.create(null), { timeout: 100 });
  const originalConfig = vm.runInNewContext(`${baseline.originalBlocks.AI_CONFIG}\nAI_CONFIG`, Object.create(null), { timeout: 100 });
  const keys = Object.keys(config).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...Object.keys(originalConfig), 'workerUrl'].sort()) ||
      typeof config.workerUrl !== 'string' || Object.keys(originalConfig).some(key => config[key] !== originalConfig[key])) {
    throw new Error('Frontend configuration allowlist check failed');
  }
  if (config.apiKey !== '__AI_KEY__' || /\bsk-[A-Za-z0-9_-]{16,}\b|\bAIza[0-9A-Za-z_-]{20,}\b/.test(html)) {
    throw new Error('Secret scan failed');
  }
  if (/Authorization|apiKey|api\.deepseek\.com|baseUrl/i.test(blocks.fetch) ||
      !blocks.fetch.includes("credentials: 'omit'") || !blocks.fetch.includes("'X-AI-Stage': stage")) {
    throw new Error('AI transport isolation check failed');
  }
  return { config, blocks, protectedSha256: sha256(protectedSource) };
}

async function safeDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe output directory');
  }
  if (await realpath(absolute) !== absolute) throw new Error('Unsafe output directory');
  return lstat(absolute);
}

function publicWorkerUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('A valid HTTPS Worker /api/ai URL is required'); }
  if (url.protocol !== 'https:' || url.pathname !== '/api/ai' || url.username || url.password || url.search || url.hash ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('A public HTTPS Worker /api/ai URL is required');
  return url.href;
}

export async function buildPages({ outputDir = defaultOutput, workerUrl, requireWorker = false } = {}) {
  let { html, baseline } = await sourceAndBaseline();
  let inspected = inspectFrontend(html, baseline);
  if (workerUrl !== undefined) {
    const normalized = publicWorkerUrl(workerUrl);
    const configPattern = new RegExp(baseline.patterns.AI_CONFIG);
    const configured = inspected.blocks.AI_CONFIG.replace(/\bworkerUrl\s*:\s*(['"])(.*?)\1/, () => `workerUrl: ${JSON.stringify(normalized)}`);
    if (configured === inspected.blocks.AI_CONFIG && inspected.config.workerUrl !== normalized) throw new Error('Worker config field not found');
    html = html.replace(configPattern, () => configured);
    inspected = inspectFrontend(html, baseline);
  }
  if (requireWorker) publicWorkerUrl(inspected.config.workerUrl);
  const output = path.resolve(outputDir);
  // Validate the parent before creating the final directory; reject linked ancestors.
  await safeDirectory(path.dirname(output));
  await mkdir(output, { recursive: true });
  const directoryInfo = await safeDirectory(output);
  const existing = await readdir(output);
  if (existing.some(name => name !== 'index.html')) throw new Error('Output directory must contain only index.html');
  const target = path.join(output, 'index.html');
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe output file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o644);
  try {
    const currentDirectory = await safeDirectory(output);
    const fileInfo = await handle.stat();
    if (currentDirectory.dev !== directoryInfo.dev || currentDirectory.ino !== directoryInfo.ino || !fileInfo.isFile()) {
      throw new Error('Output directory changed during build');
    }
    await handle.truncate(0);
    await handle.writeFile(html, { encoding: 'utf8' });
  } finally { await handle.close(); }
  if (JSON.stringify(await readdir(output)) !== '["index.html"]') throw new Error('Unexpected publish artifact');
  return { output, files: ['index.html'], bytes: Buffer.byteLength(html), protectedSha256: inspected.protectedSha256, workerConfigured: Boolean(inspected.config.workerUrl) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(['--require-worker', '--worker-url']);
  let workerUrl;
  let requireWorker = false;
  try {
    for (let index = 0; index < args.length; index++) {
      if (!allowed.has(args[index])) throw new Error('Unsupported build argument');
      if (args[index] === '--require-worker') requireWorker = true;
      else {
        workerUrl = args[++index];
        if (!workerUrl) throw new Error('Missing Worker URL');
      }
    }
    const result = await buildPages({ workerUrl, requireWorker });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
