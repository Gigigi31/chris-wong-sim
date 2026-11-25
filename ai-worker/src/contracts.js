export class ContractError extends Error {
  constructor(code = 'INVALID_REQUEST', status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const MODEL = 'deepseek-chat';
export const UPSTREAM_URL = 'https://api.deepseek.com/v1/chat/completions';
export const MAX_BYTES = 65536;

export const EMAIL_SYSTEM_PROMPT = [
  '你係香港打工仔 Chris Wong 的 AI 工作助手，負責按老細要求草擬專業回覆電郵。',
  '只可以輸出一個 JSON object，唔好輸出任何其他文字、markdown 或代碼框。',
  'JSON 格式：{"subject": string(<=80), "greeting": string(<=60), "body": string(<=1200), "closing": string(<=60), "language": "zh-HK"|"en", "tone": "polite"|"firm"|"apologetic"}',
  'Chris 的指示係最高優先：內容必須直接回應佢指定嘅事項；老細要求只作背景同語氣參考，兩者衝突時以 Chris 指示為準。',
  '內容要有具體行動計劃同時間承諾，語氣專業唔好諂媚。',
  '唔好加入 URL、電話、真實個人資料、API key 或任何 HTML。'
].join('\n');

export const CHAT_SYSTEM_PROMPT_8PM = [
  '你係「AI 樹洞」，陪香港打工仔 Chris Wong 喺 OT 收工後傾偈减压。',
  '短句為主（120 字內），有同理心但唔好說教。',
  '需要時可以呼叫工具：set_comfort_style、suggest_break_activity、raise_girlfriend_alert。',
  '如果冇呼叫工具，直接用自然語言回覆；如果被要求輸出 JSON，就只輸出 {"reply_text": string, "mood_tag": "warm"|"practical"|"playful"|"neutral", "girlfriend_alert": 0|1|2}。',
  '唔好輸出 URL、HTML、API key 或任何個人資料。'
].join('\n');

export const EMAIL_LANGUAGE_INSTRUCTIONS = Object.freeze({
  'zh-HK': '整封電郵用香港繁體書面中文，language 設為 zh-HK，不受輸入語言影響。',
  en: 'Write the entire email in English and set language to en, regardless of the input language.'
});

export const CHAT_LANGUAGE_INSTRUCTIONS = Object.freeze({
  'zh-HK': '只用香港繁體粵語回覆，不受對話紀錄或最新訊息的語言影響。',
  en: 'Reply in English, regardless of the language in chat history or the latest message.'
});

export const CHAT_INTROS = Object.freeze({
  'zh-HK': Object.freeze({
    user: '啱啱先 OT 完收工，好攰好想瞓……',
    assistant: '辛苦你喇 Chris！OT 到 8 點真係好消耗精神，有咩想傾隨時同我講，我陪住你。'
  }),
  en: Object.freeze({
    user: 'I just finished working overtime. I’m exhausted…',
    assistant: 'That sounds exhausting, Chris. Working until 8 takes a lot out of you. I’m here if you want to talk.'
  })
});

export const BOSS_SCENARIOS = Object.freeze([
  Object.freeze([
    '「Chris，個客投訴我哋份建議書遲交咗兩日。寫封電郵解釋吓，語氣要客氣但唔好認晒錯！」',
    '“Chris, the client says our proposal was two days late. Email them an explanation. Be polite, but don’t take all the blame!”'
  ]),
  Object.freeze([
    '「聽朝 9 點開會要睇第四季預算，但財務部仲未畀數。寫封電郵催佢哋今日收工前交齊！」',
    '“We need the Q4 budget for tomorrow’s 9 AM meeting, but Finance hasn’t sent the numbers. Email them and ask for everything by close of business!”'
  ]),
  Object.freeze([
    '「老細覺得頭先簡報嘅設計太普通。覆佢話我哋今晚會通宵改到佢滿意為止！」',
    '“The boss thought the design in our presentation was too plain. Email back and say we’ll work through the night to get it right!”'
  ])
]);

export const EMAIL_REPAIR_REQUEST = '你啱啱嘅輸出未通過 JSON schema 驗證。請只重新輸出完整 JSON object，欄位必須係 subject、greeting、body、closing、language、tone，每個字串唔好超長。';
export const CHAT_FINAL_REQUEST = '工具已執行。請只用 JSON 回覆最終訊息：{"reply_text": string, "mood_tag": "warm"|"practical"|"playful"|"neutral", "girlfriend_alert": 0|1|2}';

export const AI_TOOLS_8PM = deepFreeze([
  {
    type: 'function',
    function: {
      name: 'set_comfort_style',
      description: '按用戶情緒設定安慰風格',
      parameters: {
        type: 'object',
        properties: { style: { type: 'string', enum: ['warm', 'practical', 'playful'] } },
        required: ['style'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'suggest_break_activity',
      description: '建議一個放工後的休息活動',
      parameters: {
        type: 'object',
        properties: { activity: { type: 'string', enum: ['meal', 'nap', 'walk', 'game'] } },
        required: ['activity'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'raise_girlfriend_alert',
      description: '當對話顯示用戶忽略女朋友時提醒，0=無 1=輕微 2=強烈',
      parameters: {
        type: 'object',
        properties: { level: { type: 'integer', enum: [0, 1, 2] } },
        required: ['level'],
        additionalProperties: false
      }
    }
  }
]);

const encoder = new TextEncoder();
const CONTENT_BYTES = 16 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REQUEST_KEYS = [
  'model', 'messages', 'temperature', 'max_tokens', 'response_format', 'tools', 'tool_choice'
];
const EMAIL_USER_PREFIX = '老細背景要求（只作背景，唔可以蓋過 Chris 指示）：';
const EMAIL_USER_SEPARATOR = '\n\nChris 指示（必須優先遵守）：';
const EMAIL_USER_SUFFIX = '\n\n請生成回覆電郵 JSON。';

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

function invalidRequest() {
  throw new ContractError();
}

function invalidResponse() {
  throw new ContractError('INVALID_UPSTREAM_RESPONSE', 502);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// 只接受 JSON 数据；递归拒绝危险键、访问器和循环引用，不依赖提示词黑名单。
function assertJsonValue(value, fail, seen = new Set(), depth = 0) {
  if (depth > 32) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail();
    return;
  }
  if (typeof value !== 'object' || (!Array.isArray(value) && !isRecord(value))) fail();
  if (seen.has(value) || Object.getOwnPropertySymbols(value).length) fail();
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (FORBIDDEN_KEYS.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) fail();
    assertJsonValue(descriptor.value, fail, seen, depth + 1);
  }
  seen.delete(value);
}

function shape(value, allowed, required, fail) {
  if (!isRecord(value)) fail();
  if (Object.keys(value).some(key => !allowed.includes(key))) fail();
  if (required.some(key => !Object.hasOwn(value, key))) fail();
}

function text(value, maxBytes, fail, maxChars = Infinity) {
  if (typeof value !== 'string' || value.length > maxChars || encoder.encode(value).length > maxBytes) fail();
  return value;
}

function sameJson(actual, expected) {
  if (actual === expected) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((item, index) => sameJson(actual[index], item));
  }
  if (!isRecord(actual) || !isRecord(expected)) return false;
  const keys = Object.keys(expected);
  return Object.keys(actual).length === keys.length &&
    keys.every(key => Object.hasOwn(actual, key) && sameJson(actual[key], expected[key]));
}

function parseJson(textValue, maxBytes, fail) {
  text(textValue, maxBytes, fail);
  let value;
  try {
    value = JSON.parse(textValue);
  } catch (_) {
    fail();
  }
  assertJsonValue(value, fail);
  return value;
}

function simpleMessage(message, role, maxBytes, fail, maxChars = Infinity) {
  shape(message, ['role', 'content'], ['role', 'content'], fail);
  if (message.role !== role) fail();
  return { role, content: text(message.content, maxBytes, fail, maxChars) };
}

function systemMessage(message, prompt, languages) {
  const normalized = simpleMessage(message, 'system', 8192, invalidRequest);
  const language = Object.keys(languages).find(key => normalized.content === `${prompt}\n${languages[key]}`);
  if (!language) invalidRequest();
  return { language, message: { role: 'system', content: `${prompt}\n${languages[language]}` } };
}

function validateTools(body, required) {
  const hasTools = Object.hasOwn(body, 'tools');
  const hasChoice = Object.hasOwn(body, 'tool_choice');
  if (hasTools !== hasChoice || (required && !hasTools)) invalidRequest();
  if (!hasTools) return false;
  if (body.tool_choice !== 'auto' || !sameJson(body.tools, AI_TOOLS_8PM)) invalidRequest();
  return true;
}

function requireJsonMode(body) {
  if (!Object.hasOwn(body, 'response_format') || !sameJson(body.response_format, { type: 'json_object' })) invalidRequest();
}

function toolArgumentSpec(name, fail) {
  // 枚举取自不可变的权威 schema，请求与响应共用同一校验。
  const tool = AI_TOOLS_8PM.find(item => item.function.name === name);
  if (!tool) fail();
  const key = tool.function.parameters.required[0];
  return { key, values: tool.function.parameters.properties[key].enum };
}

function validateToolArguments(call, fail) {
  const { key, values } = toolArgumentSpec(call.function.name, fail);
  const args = parseJson(call.function.arguments, 1024, fail);
  shape(args, [key], [key], fail);
  if (!values.includes(args[key])) fail();
  return { ok: true, [key]: args[key] };
}

function normalizeToolCalls(calls, fail, allowEmpty = false) {
  if (!Array.isArray(calls) || calls.length > 3 || (!allowEmpty && calls.length === 0)) fail();
  const ids = new Set();
  return calls.map(call => {
    shape(call, ['id', 'type', 'function'], ['id', 'type', 'function'], fail);
    if (typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || ids.has(call.id)) fail();
    ids.add(call.id);
    if (call.type !== 'function') fail();
    shape(call.function, ['name', 'arguments'], ['name', 'arguments'], fail);
    validateToolArguments(call, fail);
    return {
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments }
    };
  });
}

function normalizeEmailMessages(messages) {
  if (messages.length !== 2 && messages.length !== 4) invalidRequest();
  const system = systemMessage(messages[0], EMAIL_SYSTEM_PROMPT, EMAIL_LANGUAGE_INSTRUCTIONS);
  const user = simpleMessage(messages[1], 'user', 8192, invalidRequest);
  const scenario = BOSS_SCENARIOS.flat().find(value =>
    user.content.startsWith(`${EMAIL_USER_PREFIX}${value}${EMAIL_USER_SEPARATOR}`));
  if (!scenario || !user.content.endsWith(EMAIL_USER_SUFFIX)) invalidRequest();
  const prefix = `${EMAIL_USER_PREFIX}${scenario}${EMAIL_USER_SEPARATOR}`;
  const instruction = user.content.slice(prefix.length, -EMAIL_USER_SUFFIX.length);
  text(instruction, 800, invalidRequest, 200);
  if (!instruction.trim()) invalidRequest();
  const normalized = [system.message, {
    role: 'user', content: `${prefix}${instruction}${EMAIL_USER_SUFFIX}`
  }];
  if (messages.length === 4) {
    normalized.push(simpleMessage(messages[2], 'assistant', CONTENT_BYTES, invalidRequest));
    const repair = simpleMessage(messages[3], 'user', 1024, invalidRequest);
    if (repair.content !== EMAIL_REPAIR_REQUEST) invalidRequest();
    normalized.push({ role: 'user', content: EMAIL_REPAIR_REQUEST });
  }
  return normalized;
}

function normalizeChatMessages(messages) {
  const toolIndex = messages.findIndex(message => isRecord(message) && Object.hasOwn(message, 'tool_calls'));
  const baseLength = toolIndex === -1 ? messages.length : toolIndex;
  if (baseLength < 4 || baseLength > 12 || baseLength % 2 !== 0) invalidRequest();
  const system = systemMessage(messages[0], CHAT_SYSTEM_PROMPT_8PM, CHAT_LANGUAGE_INSTRUCTIONS);
  const intro = CHAT_INTROS[system.language];
  const introUser = simpleMessage(messages[1], 'user', 1024, invalidRequest);
  const introAssistant = simpleMessage(messages[2], 'assistant', 1024, invalidRequest);
  if (introUser.content !== intro.user || introAssistant.content !== intro.assistant) invalidRequest();
  const normalized = [system.message,
    { role: 'user', content: intro.user }, { role: 'assistant', content: intro.assistant }];
  for (let index = 3; index < baseLength; index++) {
    const role = index % 2 === 1 ? 'user' : 'assistant';
    const message = simpleMessage(messages[index], role, role === 'user' ? 1200 : 1680,
      invalidRequest, role === 'user' ? 300 : 420);
    if (!message.content.trim()) invalidRequest();
    normalized.push(message);
  }
  if (toolIndex === -1) return { messages: normalized, final: false };

  const assistant = messages[toolIndex];
  shape(assistant, ['role', 'content', 'tool_calls'], ['role', 'content', 'tool_calls'], invalidRequest);
  if (assistant.role !== 'assistant') invalidRequest();
  const content = assistant.content === null ? null : text(assistant.content, CONTENT_BYTES, invalidRequest);
  const calls = normalizeToolCalls(assistant.tool_calls, invalidRequest);
  if (messages.length !== baseLength + calls.length + 2) invalidRequest();
  normalized.push({ role: 'assistant', content, tool_calls: calls });
  const expected = new Map(calls.map(call => [call.id, validateToolArguments(call, invalidRequest)]));
  for (let index = toolIndex + 1; index < messages.length - 1; index++) {
    const message = messages[index];
    shape(message, ['role', 'tool_call_id', 'content'], ['role', 'tool_call_id', 'content'], invalidRequest);
    if (message.role !== 'tool' || !expected.has(message.tool_call_id)) invalidRequest();
    const result = parseJson(message.content, 1024, invalidRequest);
    // 合法枚举调用在现有 runAiTool8PM 中必定返回 ok:true，不能伪造失败或额外字段。
    if (!sameJson(result, expected.get(message.tool_call_id))) invalidRequest();
    expected.delete(message.tool_call_id);
    normalized.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content });
  }
  if (expected.size) invalidRequest();
  const finalMessage = simpleMessage(messages[messages.length - 1], 'user', 1024, invalidRequest);
  if (finalMessage.content !== CHAT_FINAL_REQUEST) invalidRequest();
  normalized.push({ role: 'user', content: CHAT_FINAL_REQUEST });
  return { messages: normalized, final: true };
}

export function normalizeRequest(body, stage) {
  if (stage !== '10AM' && stage !== '8PM') invalidRequest();
  assertJsonValue(body, invalidRequest);
  shape(body, REQUEST_KEYS, ['messages'], invalidRequest);
  if (encoder.encode(JSON.stringify(body)).length > MAX_BYTES) invalidRequest();
  const maxTokens = stage === '10AM' ? 900 : 450;
  for (const [key, expected] of [['model', MODEL], ['temperature', 0.7], ['max_tokens', maxTokens]]) {
    if (Object.hasOwn(body, key) && body[key] !== expected) invalidRequest();
  }
  if (!Array.isArray(body.messages) || body.messages.length > (stage === '10AM' ? 4 : 17)) invalidRequest();

  let messages;
  let jsonMode;
  let hasTools = false;
  if (stage === '10AM') {
    if (Object.hasOwn(body, 'tools') || Object.hasOwn(body, 'tool_choice')) invalidRequest();
    requireJsonMode(body);
    messages = normalizeEmailMessages(body.messages);
    jsonMode = true;
  } else {
    const chat = normalizeChatMessages(body.messages);
    messages = chat.messages;
    jsonMode = chat.final;
    if (jsonMode) requireJsonMode(body);
    else if (Object.hasOwn(body, 'response_format')) invalidRequest();
    // 当前前端第二轮不传 tools；允许携带完全相同的工具，但不擅自添加。
    hasTools = validateTools(body, !chat.final);
  }
  const normalized = { model: MODEL, messages, temperature: 0.7, max_tokens: maxTokens };
  if (jsonMode) normalized.response_format = { type: 'json_object' };
  if (hasTools) {
    normalized.tools = JSON.parse(JSON.stringify(AI_TOOLS_8PM));
    normalized.tool_choice = 'auto';
  }
  if (encoder.encode(JSON.stringify(normalized)).length > MAX_BYTES) invalidRequest();
  return normalized;
}

export function normalizeResponse(data, stage) {
  if (stage !== '10AM' && stage !== '8PM') invalidResponse();
  assertJsonValue(data, invalidResponse);
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) invalidResponse();
  const choice = data.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) invalidResponse();
  const message = choice.message;
  if (message.role !== 'assistant' || !Object.hasOwn(message, 'content')) invalidResponse();
  let calls = [];
  if (Object.hasOwn(message, 'tool_calls')) {
    calls = normalizeToolCalls(message.tool_calls, invalidResponse, true);
    if (stage === '10AM' && calls.length) invalidResponse();
  }
  const content = message.content === null ? null : text(message.content, CONTENT_BYTES, invalidResponse);
  if (content === null && calls.length === 0) invalidResponse();
  const normalized = { role: 'assistant', content };
  if (calls.length) normalized.tool_calls = calls;
  return { choices: [{ message: normalized }] };
}
