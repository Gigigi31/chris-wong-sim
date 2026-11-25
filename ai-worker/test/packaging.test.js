import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPages, sourceAndBaseline, inspectFrontend } from '../scripts/build-pages.js';

// Temp artifacts are retained; no personal files are scanned, moved or deleted.
const temp = async () => mkdtemp(path.join(await realpath(tmpdir()), 'chris-pages-test-'));

test('静态产物仅 index.html，内容基线通过且无真实密钥', async () => {
  const outputDir = await temp();
  const result = await buildPages({ outputDir });
  assert.deepEqual(await readdir(outputDir), ['index.html']);
  assert.equal(result.workerConfigured, false);
  const { html, baseline } = await sourceAndBaseline();
  assert.equal(await readFile(path.join(outputDir, 'index.html'), 'utf8'), html);
  assert.equal(inspectFrontend(html, baseline).protectedSha256, baseline.protectedSha256);
});

test('发佈时必须提供有效公开 HTTPS Worker URL，不改变受保护前端', async () => {
  const outputDir = await temp();
  await assert.rejects(buildPages({ outputDir, requireWorker: true }), /HTTPS Worker/);
  const result = await buildPages({ outputDir, workerUrl: 'https://ai-worker.example/api/ai', requireWorker: true });
  const { baseline, html: original } = await sourceAndBaseline();
  const published = await readFile(path.join(outputDir, 'index.html'), 'utf8');
  assert.equal(result.workerConfigured, true);
  assert.equal(inspectFrontend(published, baseline).protectedSha256, baseline.protectedSha256);
  assert.equal(inspectFrontend(published, baseline).config.workerUrl, 'https://ai-worker.example/api/ai');
  assert.equal(inspectFrontend(original, baseline).config.workerUrl, '');
});

for (const workerUrl of ['http://worker.example/api/ai', 'https://worker.example/?target=x', 'https://user:pass@worker.example/api/ai', 'https://worker.example/api/ai?key=x', 'https://localhost/api/ai']) {
  test('发布器拒绝非公开专用 Worker 配置 ' + workerUrl, async () => {
    await assert.rejects(buildPages({ outputDir: await temp(), workerUrl, requireWorker: true }), /Worker/);
  });
}

test('有非白名单文件的产物目录直接拒绝，不删除或覆盖它', async () => {
  const outputDir = await temp();
  await writeFile(path.join(outputDir, 'unapproved.txt'), 'retain');
  await assert.rejects(buildPages({ outputDir }), /only index.html/);
  assert.equal(await readFile(path.join(outputDir, 'unapproved.txt'), 'utf8'), 'retain');
});

test('CSS／文案／玩法改变会使发佈失败', async () => {
  const { html, baseline } = await sourceAndBaseline();
  assert.throws(() => inspectFrontend(html.replace('<style>', '<style>/* unapproved */'), baseline), /Protected frontend/);
});

test('即使修改区块获准，apiKey 也不能换成任何真实值', async () => {
  const { html, baseline } = await sourceAndBaseline();
  assert.throws(() => inspectFrontend(html.replace("apiKey: '__AI_KEY__'", "apiKey: 'unit-test-no-live-key'"), baseline), /Secret scan|configuration allowlist/);
});

test('拒绝输出目录符号链接，不修改链接目标内容', async () => {
  const parent = await temp();
  const target = await temp();
  await writeFile(path.join(target, 'index.html'), 'untouched');
  const linked = path.join(parent, 'linked-output');
  await symlink(target, linked, 'dir');
  await assert.rejects(buildPages({ outputDir: linked }), /Unsafe output directory/);
  assert.equal(await readFile(path.join(target, 'index.html'), 'utf8'), 'untouched');
});

test('拒绝配置中新增秘密字段，即使位于允许修改的区块', async () => {
  const { html, baseline } = await sourceAndBaseline();
  const changed = html.replace("workerUrl: ''", "workerUrl: '', serviceSecret: 'not-live'");
  assert.throws(() => inspectFrontend(changed, baseline), /configuration allowlist/);
});

test('workflow 仅手动触发，上传隔离目录且无根目录发布', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|schedule):/m);
  assert.match(workflow, /path: ai-worker\/pages-dist/);
  assert.match(workflow, /--require-worker/);
  assert.doesNotMatch(workflow, /path: ['"]?\.['"]?\s*$/m);
});
