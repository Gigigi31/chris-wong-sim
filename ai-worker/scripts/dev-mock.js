import http from 'node:http';
import { createWorker } from '../src/index.js';
import { inspectFrontend, sourceAndBaseline } from './build-pages.js';

// Local preview uses only an in-memory mock. Never reads .env or calls DeepSeek.
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const origin = `http://127.0.0.1:${port}`;
const { html, baseline } = await sourceAndBaseline();
const { blocks } = inspectFrontend(html, baseline);
const configured = blocks.AI_CONFIG.replace(/\bworkerUrl\s*:\s*(['"])(.*?)\1/, () => `workerUrl: '${origin}/api/ai'`);
const preview = html.replace(new RegExp(baseline.patterns.AI_CONFIG), () => configured);
const counters = new Map();
const limiter = maximum => ({
  async limit({ key }) {
    const id = `${maximum}:${key}:${Math.floor(Date.now() / 60000)}`;
    const count = counters.get(id) || 0;
    if (count >= maximum) return { success: false };
    counters.set(id, count + 1);
    if (counters.size > 1000) counters.clear();
    return { success: true };
  }
});
const env = {
  SERVICE_ENABLED: 'true', ALLOWED_ORIGINS: origin, DEEPSEEK_API_KEY: 'local-mock-key-not-live',
  IP_RATE_LIMITER: limiter(24), SERVICE_RATE_LIMITER: limiter(60)
};
const worker = createWorker({ fetchUpstream: async (_url, options) => {
  const body = JSON.parse(options.body);
  const english = body.messages[0].content.includes('regardless of');
  const email = body.max_tokens === 900;
  const content = email ? JSON.stringify({
    subject: english ? 'Local mock follow-up' : '本機模擬：跟進安排',
    greeting: english ? 'Hello,' : '您好：',
    body: english ? 'This is an offline mock response. No AI balance was used.' : '這是本機模擬回覆，沒有呼叫真實 AI，也沒有消耗餘額。',
    closing: 'Chris Wong', language: english ? 'en' : 'zh-HK', tone: 'polite'
  }) : (english ? 'This is an offline mock. Take a short rest after work.' : '本機模擬回覆：今日辛苦喇，先好好休息。');
  return Response.json({ choices: [{ message: { role: 'assistant', content } }] });
} });
const server = http.createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.on('close', () => controller.abort());
  try {
    if (incoming.headers.host !== `127.0.0.1:${port}`) {
      outgoing.writeHead(403); outgoing.end(); return;
    }
    if (incoming.method === 'GET' && ['/', '/index.html'].includes(incoming.url)) {
      outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      outgoing.end(preview); return;
    }
    if (incoming.method === 'GET' && incoming.url === '/favicon.ico') { outgoing.writeHead(204); outgoing.end(); return; }
    if (incoming.url !== '/api/ai') { outgoing.writeHead(404); outgoing.end(); return; }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of incoming) {
      bytes += chunk.length;
      if (bytes > 65536) { outgoing.writeHead(413); outgoing.end(); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
    headers.set('cf-connecting-ip', '127.0.0.1');
    const request = new Request(`${origin}/api/ai`, {
      method: incoming.method, headers, signal: controller.signal,
      ...(['GET', 'HEAD', 'OPTIONS'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) })
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (_) {
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'Cache-Control': 'no-store' });
    outgoing.end();
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Offline AI mock preview: ${origin}`);
  console.log('Only index.html and the mock API are served. Real AI usage: zero.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
