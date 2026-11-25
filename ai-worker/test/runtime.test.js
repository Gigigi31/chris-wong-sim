import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { EMAIL_SYSTEM_PROMPT, EMAIL_LANGUAGE_INSTRUCTIONS, BOSS_SCENARIOS } from '../src/contracts.js';

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

test('真实 workerd 运行时兼容性、限流绑定及模拟出站', { timeout: 30000 }, async () => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', write: false
  });
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-11-25',
    host: '127.0.0.1', port: 0, cf: false,
    bindings: { SERVICE_ENABLED: 'true', ALLOWED_ORIGINS: 'https://demo.example', DEEPSEEK_API_KEY: 'unit-test-key-not-live' },
    ratelimits: {
      IP_RATE_LIMITER: { namespace_id: '761101', simple: { limit: 24, period: 60 } },
      SERVICE_RATE_LIMITER: { namespace_id: '761102', simple: { limit: 60, period: 60 } }
    },
    outboundService: async request => {
      calls++;
      assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(request.headers.get('authorization'), 'Bearer unit-test-key-not-live');
      const body = await request.json();
      assert.equal(body.max_tokens, 900);
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'offline runtime mock' } }] });
    }
  }));
  try {
    const body = { model: 'deepseek-chat', temperature: 0.7, max_tokens: 900, response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: `${EMAIL_SYSTEM_PROMPT}\n${EMAIL_LANGUAGE_INSTRUCTIONS['zh-HK']}` },
      { role: 'user', content: `老細背景要求（只作背景，唔可以蓋過 Chris 指示）：${BOSS_SCENARIOS[0][0]}\n\nChris 指示（必須優先遵守）：請跟進。\n\n請生成回覆電郵 JSON。` }
    ] };
    const headers = { Origin: 'https://demo.example', 'Content-Type': 'application/json', 'X-AI-Stage': '10AM', 'cf-connecting-ip': '192.0.2.10' };
    const response = await mf.dispatchFetch('https://worker.example/api/ai', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).choices[0].message.content, 'offline runtime mock');
    assert.equal(calls, 1);
    const rejected = await mf.dispatchFetch('https://worker.example/api/ai', { method: 'POST', headers: { ...headers, Origin: 'https://unapproved.example' }, body: JSON.stringify(body) });
    assert.equal(rejected.status, 403);
    assert.equal(calls, 1);
  } finally { await mf.dispose(); }
});
