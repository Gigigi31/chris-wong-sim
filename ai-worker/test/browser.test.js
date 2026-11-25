import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createWorker } from '../src/index.js';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/frontend-baseline.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL(`../../${baseline.source}`, import.meta.url), 'utf8');
// 此地址仅由 Playwright 内存路由处理，不启动端口或静态文件服务器。
const origin = 'http://127.0.0.1:4173';
const pageUrl = `${origin}/index.html`;
const workerUrl = `${origin}/api/ai`;
const dummyKey = 'unit-test-key-not-live';
const email = {
  subject: '测试邮件跟进', greeting: '您好：', body: '我會今日整理進度，並於下午提供更新。',
  closing: '此致\nChris Wong', language: 'zh-HK', tone: 'polite'
};
const textCompletion = (content, extra = {}) => Response.json({
  choices: [{ message: { role: 'assistant', content, ...extra } }]
});
const emailCompletion = (value = email) => textCompletion(JSON.stringify(value));
const sha256 = text => createHash('sha256').update(text).digest('hex');

function originalHtml() {
  let html = source;
  for (const name of ['AI_CONFIG', 'aiEnabled', 'fetch']) {
    const pattern = new RegExp(baseline.patterns[name], 'g');
    assert.equal([...html.matchAll(pattern)].length, 1);
    html = html.replace(new RegExp(baseline.patterns[name]), () => baseline.originalBlocks[name]);
  }
  assert.equal(sha256(html), baseline.originalSha256, '允许区块以外的 HTML 已改变');
  return html;
}

function servedHtml(html, configured) {
  if (configured) {
    const configPattern = new RegExp(baseline.patterns.AI_CONFIG);
    const config = html.match(configPattern)?.[0];
    assert.ok(config, '找不到 AI_CONFIG');
    const emptyWorker = /\bworkerUrl\s*:\s*(['"])\1/g;
    assert.equal([...config.matchAll(emptyWorker)].length, 1, '源码 workerUrl 必须保持空字符串');
    const patched = config.replace(emptyWorker, () => `workerUrl: '${workerUrl}'`);
    html = html.replace(configPattern, () => patched);
  }
  assert.ok(!html.includes(dummyKey), '不得向浏览器注入测试服务端 key');
  // preconnect 不经过请求路由，测试副本移除它，阻止提前连接字体服务器。
  return html.replace(/<link\b[^>]*\brel=["']preconnect["'][^>]*>/gi, '');
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function launchBrowser() {
  const options = {
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-first-run', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']
  };
  if (process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
    return chromium.launch({ ...options, channel: 'chrome' });
  }
  return chromium.launch(options);
}

async function harness(browser, { html = source, configured = true, upstream = async () => emailCompletion(), timeoutMs = 3000 } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'zh-HK'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  const unexpected = [];
  const workerCalls = [];
  const upstreamCalls = [];
  const forwardControllers = new Map();
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => forwardControllers.get(request)?.abort());
  await page.addInitScript(() => {
    // Both comparison pages must choose the same random boss scenario during smoke checks.
    Math.random = () => 0.5;
    const nativeFetch = window.fetch.bind(window);
    window.__testAiFetches = [];
    window.fetch = (url, options = {}) => {
      const entry = {
        url: String(url), method: options.method, credentials: options.credentials,
        headers: Object.fromEntries(new Headers(options.headers).entries()),
        body: options.body, settled: false
      };
      window.__testAiFetches.push(entry);
      return nativeFetch(url, options).finally(() => { entry.settled = true; });
    };
  });
  const worker = createWorker({
    timeoutMs,
    fetchUpstream: async (url, options) => {
      const request = new Request(url, options);
      const body = JSON.parse(await request.clone().text());
      const call = { url: request.url, headers: Object.fromEntries(request.headers), body, signal: request.signal };
      upstreamCalls.push(call);
      // 永远不调用全局 fetch；唯一的上游是测试提供的函数。
      return upstream(call, upstreamCalls.length);
    }
  });
  const env = {
    SERVICE_ENABLED: 'true', ALLOWED_ORIGINS: origin, DEEPSEEK_API_KEY: dummyKey,
    IP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SERVICE_RATE_LIMITER: { limit: async () => ({ success: true }) }
  };
  const content = servedHtml(html, configured);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.url() === pageUrl && request.isNavigationRequest() && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: content });
      return;
    }
    if (request.url() === workerUrl && request.method() === 'POST') {
      const finished = deferred();
      const controller = new AbortController();
      forwardControllers.set(request, controller);
      const headers = new Headers(await request.allHeaders());
      headers.set('cf-connecting-ip', '192.0.2.10');
      const call = { url: request.url(), headers: Object.fromEntries(headers), body: JSON.parse(request.postData()), done: finished.promise };
      workerCalls.push(call);
      try {
        const forwarded = new Request(workerUrl, {
          method: 'POST', headers, body: request.postDataBuffer(), signal: controller.signal
        });
        const response = await worker.fetch(forwarded, env, { waitUntil() {} });
        call.status = response.status;
        call.response = await response.text();
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: call.response });
      } catch (error) {
        if (!controller.signal.aborted) {
          errors.push(`内存 Worker 路由：${error.message}`);
          await route.abort('failed').catch(() => {});
        }
      } finally {
        forwardControllers.delete(request);
        finished.resolve();
      }
      return;
    }
    if (url.protocol === 'https:' && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname) && request.method() === 'GET') {
      await route.fulfill({ status: 200, body: '', contentType: url.hostname === 'fonts.googleapis.com' ? 'text/css' : 'font/woff2' });
      return;
    }
    unexpected.push(`${request.method()} ${request.url()}`);
    await route.abort('blockedbyclient');
  });
  try {
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => /ALL 6 CHECKS PASSED/.test(document.querySelector('#smokeSummaryText')?.textContent || ''));
  } catch (error) {
    await context.close();
    throw error;
  }
  return {
    page, context, workerCalls, upstreamCalls, errors, unexpected,
    async clean() {
      await context.close();
      assert.deepEqual(unexpected, [], '有未允许的请求，已经中止，未发出真实网络流量');
      assert.deepEqual(errors, [], '网页或 Worker 路由出现未捕获异常');
    }
  };
}

async function useHarness(t, browser, options) {
  const h = await harness(browser, options);
  t.after(() => h.clean());
  return h;
}

async function waitBadge(page, pattern) {
  await page.waitForFunction(patternSource => new RegExp(patternSource).test(document.querySelector('#emailStatusBadge')?.textContent || ''), pattern.source);
}

async function submitMail(page, prompt = '請今日下午提供工作進度') {
  await page.locator('#btn10AM').click();
  await page.locator('#emailAiInput').fill(prompt);
  await page.locator('#emailAiForm button[type="submit"]').click();
}

async function enterChat(page) {
  await page.locator('#btn8PM').click();
  // 保留实际 1650ms 开场动画，等待输入可用，而不是绕过游戏状态。
  await page.waitForFunction(() => !document.querySelector('#chatInput8PM').disabled && !document.querySelector('#chatSend8PM').disabled);
}

async function assertPrivateTransport(h, stage) {
  const calls = await h.page.evaluate(() => window.__testAiFetches);
  assert.equal(calls.length, h.workerCalls.length);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, workerUrl);
    assert.equal(call.credentials, 'omit');
    assert.equal(call.method, 'POST');
    assert.deepEqual(Object.keys(call.headers).sort(), ['content-type', 'x-ai-stage']);
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['x-ai-stage'], stage);
    assert.doesNotMatch(call.body, /unit-test-key-not-live|__AI_KEY__|apiKey|Bearer/);
  }
  for (const call of h.workerCalls) {
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers['cf-connecting-ip'], '192.0.2.10');
    assert.doesNotMatch(call.response || '', /unit-test-key-not-live|Bearer/);
  }
  for (const call of h.upstreamCalls) {
    assert.equal(call.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(call.headers.authorization, `Bearer ${dummyKey}`);
  }
  assert.equal(await h.page.evaluate(key => document.documentElement.outerHTML.includes(key), dummyKey), false);
}

async function homeSnapshot(page) {
  return page.evaluate(() => {
    const describe = element => {
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return {
        tag: element.tagName, id: element.id, className: element.className,
        text: element instanceof HTMLCanvasElement ? '' : element.textContent,
        width: rect.width, height: rect.height, display: css.display,
        color: css.color, background: css.backgroundColor, font: css.fontFamily,
        ...(element instanceof HTMLCanvasElement ? { bitmapWidth: element.width, bitmapHeight: element.height } : {})
      };
    };
    return [...document.querySelectorAll('#homeScreen .time-slot-btn, #harbourCanvas, #gameCanvas, #canvasWrapper')].map(describe);
  });
}

test('浏览器：实际 HTML 和 Worker 全内存集成，无真实 DeepSeek 或部署', { timeout: 120000 }, async t => {
  const browser = await launchBrowser();
  try {
    await t.test('重建原版与当前版各六项 smoke 全过；桌面和手机 UI/CSS/画布布局一致', async t => {
      const original = await useHarness(t, browser, { html: originalHtml(), configured: false });
      const current = await useHarness(t, browser, { configured: false });
      for (const h of [original, current]) {
        assert.match(await h.page.locator('#smokeSummaryText').textContent(), /ALL 6 CHECKS PASSED/);
        assert.equal(await h.page.locator('#smokeLogList > div').count(), 6);
        const smokeRows = await h.page.locator('#smokeLogList > div').allTextContents();
        assert.ok(smokeRows.every(row => row.codePointAt(0) === 0x2705), '每项 smoke check 必须显示通过标记');
        assert.equal(await h.page.locator('#homeScreen .time-slot-btn').count(), 8);
        assert.equal(await h.page.locator('#harbourCanvas').evaluate(canvas => Boolean(canvas.getContext('2d')) && canvas.width > 0 && canvas.height > 0), true);
      }
      assert.deepEqual(await homeSnapshot(current.page), await homeSnapshot(original.page));
      for (const h of [original, current]) {
        await h.page.setViewportSize({ width: 390, height: 844 });
        await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      assert.deepEqual(await homeSnapshot(current.page), await homeSnapshot(original.page));
      assert.equal(original.workerCalls.length + current.workerCalls.length, 0);
    });

    await t.test('八个阶段按钮可进入并返回 HOME；canvas 初始化和手机表单可操作', async t => {
      const h = await useHarness(t, browser, { configured: false });
      for (const stage of ['7AM', '8AM', '10AM', '1PM', '3PM', '8PM', '10PM', '1AM']) {
        await h.page.locator(`#btn${stage}`).click();
        assert.equal(await h.page.locator('#homeScreen').isVisible(), false);
        assert.ok((await h.page.locator('#stageBadge').textContent()).length > 0);
        assert.equal(await h.page.locator('#gameCanvas').evaluate(canvas => Boolean(canvas.getContext('2d')) && canvas.width > 0 && canvas.height > 0), true);
        await h.page.locator('#homeBtn').click();
        assert.equal(await h.page.locator('#homeScreen').isVisible(), true);
      }
      await h.page.setViewportSize({ width: 390, height: 844 });
      await submitMail(h.page);
      await waitBadge(h.page, /本地|LOCAL/);
      assert.equal(await h.page.locator('#aiEmailOutput').isVisible(), true);
      await h.page.locator('#homeBtn').click();
      await enterChat(h.page);
      const input = await h.page.locator('#chatInput8PM').boundingBox();
      const send = await h.page.locator('#chatSend8PM').boundingBox();
      assert.ok(input && send && input.width > 0 && send.width > 0);
      assert.ok(input.x >= 0 && input.x + input.width <= 391);
      assert.ok(send.x >= 0 && send.x + send.width <= 391);
      await h.page.locator('#chatInput8PM').fill('今晚好攰');
      await h.page.locator('#chatSend8PM').click();
      await h.page.waitForFunction(() => !document.querySelector('#chatSend8PM').disabled && !document.querySelector('#chatTyping8PM'));
      assert.equal(h.workerCalls.length, 0);
    });

    await t.test('邮件提交经真实 Worker 返回 AI 状态、zh-HK 内容，key 只在假上游', async t => {
      const h = await useHarness(t, browser);
      await submitMail(h.page);
      await waitBadge(h.page, /(?:·\s*AI)$/);
      assert.equal(h.workerCalls.length, 1);
      assert.equal(h.upstreamCalls.length, 1);
      assert.equal(h.workerCalls[0].status, 200);
      const output = await h.page.locator('#aiEmailOutput').textContent();
      assert.ok(output.includes(email.subject));
      assert.ok(output.includes(email.body));
      assert.equal(await h.page.locator('#aiEmailOutput span[lang="zh-HK"]').count(), 1);
      assert.equal(await h.page.locator('#emailAiInput').isDisabled(), true);
      await assertPrivateTransport(h, '10AM');
    });

    await t.test('邮件首个 JSON 无效，Worker 接收第二个修复请求，UI 显示最终 AI 邮件', async t => {
      const h = await useHarness(t, browser, {
        upstream: async (_call, count) => count === 1 ? textCompletion('not json') : emailCompletion()
      });
      await submitMail(h.page);
      await waitBadge(h.page, /(?:·\s*AI)$/);
      assert.equal(h.workerCalls.length, 2);
      assert.equal(h.upstreamCalls.length, 2);
      assert.ok(h.workerCalls.every(call => call.status === 200));
      const messages = h.upstreamCalls[1].body.messages;
      assert.equal(messages.at(-2).role, 'assistant');
      assert.equal(messages.at(-2).content, 'not json');
      assert.match(messages.at(-1).content, /JSON schema/);
      assert.ok((await h.page.locator('#aiEmailOutput').textContent()).includes(email.body));
      await assertPrivateTransport(h, '10AM');
    });

    await t.test('聊天工具调用两跳经 Worker，出现工具 chip 和最终 AI 气泡', async t => {
      const tool = { id: 'call_local_style', type: 'function', function: { name: 'set_comfort_style', arguments: '{"style":"warm"}' } };
      const reply = '今日已經努力喇，返屋企好好休息。';
      const h = await useHarness(t, browser, {
        upstream: async (_call, count) => count === 1 ? textCompletion(null, { tool_calls: [tool] }) : textCompletion(JSON.stringify({
          reply_text: reply, mood_tag: 'warm', girlfriend_alert: 0
        }))
      });
      await enterChat(h.page);
      await h.page.locator('#chatInput8PM').fill('今晚好攰，想休息');
      await h.page.locator('#chatSend8PM').click();
      await h.page.waitForFunction(text => document.querySelector('#chatFeed8PM')?.textContent.includes(text), reply);
      assert.equal(h.workerCalls.length, 2);
      assert.equal(h.upstreamCalls.length, 2);
      assert.ok(h.workerCalls.every(call => call.status === 200));
      assert.equal(await h.page.locator('#chipComfort8PM').isVisible(), true);
      assert.match(await h.page.locator('#chipComfort8PM').textContent(), /溫柔安慰|Warm/);
      assert.equal(await h.page.locator('#chatTyping8PM').count(), 0);
      assert.equal(await h.page.locator('#chatSend8PM').isEnabled(), true);
      const final = h.upstreamCalls[1].body;
      const result = final.messages.find(message => message.role === 'tool');
      assert.equal(result.tool_call_id, tool.id);
      assert.deepEqual(JSON.parse(result.content), { ok: true, style: 'warm' });
      assert.deepEqual(final.response_format, { type: 'json_object' });
      await assertPrivateTransport(h, '8PM');
    });

    await t.test('上游 402 一次即降级邮件，不再尝试修复或计费请求', async t => {
      const h = await useHarness(t, browser, {
        upstream: async () => Response.json({ error: { code: 'insufficient_balance', message: '仅测试的余额不足' } }, { status: 402 })
      });
      await submitMail(h.page, '請確認測試跟進安排');
      await waitBadge(h.page, /備用|FALLBACK/);
      assert.equal(h.workerCalls.length, 1);
      assert.equal(h.upstreamCalls.length, 1);
      assert.equal(h.workerCalls[0].status, 402);
      assert.ok((await h.page.locator('#aiEmailOutput').textContent()).includes('請確認測試跟進安排'));
      assert.equal(await h.page.locator('#emailAiInput').isDisabled(), true);
      await assertPrivateTransport(h, '10AM');
    });

    await t.test('未配置 Worker 的实际源码邮件为 LOCAL、聊天为本地，零 Worker/上游调用', async t => {
      const h = await useHarness(t, browser, { configured: false });
      await submitMail(h.page);
      await waitBadge(h.page, /本地|LOCAL/);
      await h.page.locator('#homeBtn').click();
      await enterChat(h.page);
      await h.page.locator('#chatInput8PM').fill('今晚想早啲休息');
      await h.page.locator('#chatSend8PM').click();
      await h.page.waitForFunction(() => !document.querySelector('#chatSend8PM').disabled && !document.querySelector('#chatTyping8PM'));
      assert.equal(h.workerCalls.length, 0);
      assert.equal(h.upstreamCalls.length, 0);
      assert.deepEqual(await h.page.evaluate(() => window.__testAiFetches), []);
      assert.ok((await h.page.locator('#chatFeed8PM').textContent()).includes('休息'));
    });

    await t.test('邮件 AI 延迟期间返回 HOME，再进入邮件不会收到旧会话内容或状态', async t => {
      const started = deferred();
      const release = deferred();
      const lateEmail = { ...email, subject: 'LATE_RESPONSE_SHOULD_NOT_RENDER', body: '此內容屬於已離開的舊會話。' };
      const h = await useHarness(t, browser, {
        upstream: async () => { started.resolve(); await release.promise; return emailCompletion(lateEmail); },
        timeoutMs: 5000
      });
      // 无论断言成功与否都释放假上游，不遗留未结束任务。
      try {
        await submitMail(h.page);
        await waitBadge(h.page, /生成中|DRAFTING/);
        let startTimer;
        try {
          await Promise.race([started.promise, new Promise((_resolve, reject) => {
            startTimer = setTimeout(() => reject(new Error('Worker 未调用假上游')), 4000);
          })]);
        } finally { clearTimeout(startTimer); }
        await h.page.locator('#homeBtn').click();
        assert.equal(await h.page.locator('#homeScreen').isVisible(), true);
        await h.page.locator('#btn10AM').click();
        await waitBadge(h.page, /等待|WAITING/);
        release.resolve();
        await Promise.all(h.workerCalls.map(call => call.done));
        await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.doesNotMatch(await h.page.locator('#aiEmailOutput').textContent(), /LATE_RESPONSE_SHOULD_NOT_RENDER|已離開的舊會話/);
        await waitBadge(h.page, /等待|WAITING/);
        assert.equal(await h.page.locator('#emailAiInput').isEnabled(), true);
        assert.equal(h.workerCalls.length, 1);
        assert.equal(h.upstreamCalls.length, 1);
      } finally { release.resolve(); }
    });
  } finally { await browser.close(); }
});
