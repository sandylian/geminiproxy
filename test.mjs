// 本地路由测试：不访问网络，替换全局 fetch 截获上游请求做断言。
// 运行：node test.mjs（需要 Node 18+，本机 22 已验证）
import assert from 'node:assert/strict';

process.env.STREAM_HEADERS_TIMEOUT_MS = '150';      // 必须在 import 之前：模块顶层会读取
process.env.NONSTREAM_HEADERS_TIMEOUT_MS = '1200';  // 两档刻意不同值，让"档位选择"可被断言

const { default: handler } = await import('./api/_handler.js');

const BASE = 'https://proxy.example.com';
const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta/openai';
const decoder = new TextDecoder();

let captured = null;        // 最近一次被截获的上游请求
let upstreamMode = 'json';  // json | sse | network_error | hang | prefill_error | plain400

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), init };
  if (upstreamMode === 'network_error') throw new TypeError('fetch failed');
  if (upstreamMode === 'hang') {
    // 模拟上游挂起：除非被中止，永不返回；被中止时以 AbortError 拒绝（与真实 fetch 行为一致）
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')));
    });
  }
  if (upstreamMode === 'prefill_error') {
    return new Response(JSON.stringify({
      error: {
        message: 'Please ensure that multiturn requests ends with a user turn or a function response. Requests ending with a model turn are not supported.',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (upstreamMode === 'plain400') {
    return new Response(JSON.stringify({
      error: { message: 'some other upstream failure', type: 'invalid_request_error', param: null, code: null },
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (upstreamMode === 'sse') {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(JSON.stringify({ ok: true, usage: { total_tokens: 5 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const call = (path, init) => handler(new Request(BASE + path, init));
const bodyText = (b) => (typeof b === 'string' ? b : decoder.decode(b)); // chat 清洗后是字符串，其余是 ArrayBuffer

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log('路由与透传');

await t('POST /v1/chat/completions → 清洗后透传，头只留 authorization + content-type', async () => {
  const body = JSON.stringify({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'low',
    extra_body: { extra_body: { google: { thinking_config: { thinking_budget: 512 } } } },
  });
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test' },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(captured.url, `${UPSTREAM}/chat/completions`);
  assert.deepEqual(Object.keys(captured.init.headers).sort(), ['authorization', 'content-type']);
  assert.equal(captured.init.headers.authorization, 'Bearer gk-test');
  assert.deepEqual(JSON.parse(bodyText(captured.init.body)), JSON.parse(body));
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { ok: true, usage: { total_tokens: 5 } });
});

await t('POST 含 frequency_penalty 等字段 → 剥离后转发，其余字段保留', async () => {
  const body = JSON.stringify({
    model: 'gemini-3.5-flash-lite',
    messages: [{ role: 'user', content: 'hi' }],
    frequency_penalty: 0.5,
    presence_penalty: 0.2,
    logit_bias: { '50256': -100 },
    top_logprobs: 3,
    logprobs: true,
    reasoning_effort: 'low',
  });
  await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test' },
    body,
  });
  const forwarded = JSON.parse(bodyText(captured.init.body));
  assert.ok(!('frequency_penalty' in forwarded));
  assert.ok(!('presence_penalty' in forwarded));
  assert.ok(!('logit_bias' in forwarded));
  assert.ok(!('top_logprobs' in forwarded));
  assert.ok(!('logprobs' in forwarded));
  assert.equal(forwarded.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(forwarded.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(forwarded.reasoning_effort, 'low'); // 兼容层认识的字段原样保留
});

await t('流式响应透传（SSE body 可读，content-type 保留）', async () => {
  upstreamMode = 'sse';
  const res = await call('/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test' },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.match(await res.text(), /\[DONE\]/);
  upstreamMode = 'json';
});

await t('GET /v1/models → /v1beta/openai/models', async () => {
  await call('/v1/models', { method: 'GET', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(captured.url, `${UPSTREAM}/models`);
});

await t('GET /v1/models/gemini-2.5-flash → id 原样透传', async () => {
  await call('/api/v1/models/gemini-2.5-flash', { method: 'GET', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(captured.url, `${UPSTREAM}/models/gemini-2.5-flash`);
});

await t('GET /v1/models/foo%20bar → id 编码原样保留（不二次编码）', async () => {
  await call('/v1/models/foo%20bar', { method: 'GET', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(captured.url, `${UPSTREAM}/models/foo%20bar`);
});

await t('GET /v1/models/models/gemini-2.5-flash → models/ 前缀 id round-trip 整段透传', async () => {
  await call('/v1/models/models/gemini-2.5-flash', { method: 'GET', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(captured.url, `${UPSTREAM}/models/models/gemini-2.5-flash`);
});

await t('GET /v1/models/a/b → 任意深度整段透传', async () => {
  await call('/api/v1/models/a/b', { method: 'GET', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(captured.url, `${UPSTREAM}/models/a/b`);
});

await t('POST /v1/embeddings → 透传', async () => {
  const body = JSON.stringify({ model: 'gemini-embedding-001', input: 'hello' });
  await call('/v1/embeddings', { method: 'POST', headers: { authorization: 'Bearer gk-test' }, body });
  assert.equal(captured.url, `${UPSTREAM}/embeddings`);
  assert.equal(decoder.decode(captured.init.body), body);
});

await t('POST /v1/images/generations → 透传', async () => {
  const body = JSON.stringify({ model: 'gemini-2.5-flash-image', prompt: 'a cat', n: 1 });
  await call('/v1/images/generations', { method: 'POST', headers: { authorization: 'Bearer gk-test' }, body });
  assert.equal(captured.url, `${UPSTREAM}/images/generations`);
});

await t('POST /v1/videos → 透传，content-type 原样保留（multipart 可用）', async () => {
  await call('/v1/videos', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test', 'content-type': 'multipart/form-data; boundary=xyz' },
    body: '--xyz--',
  });
  assert.equal(captured.url, `${UPSTREAM}/videos`);
  assert.equal(captured.init.headers['content-type'], 'multipart/form-data; boundary=xyz');
});

await t('POST body 二进制安全（不经字符串解码）', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x0d, 0x0a]);
  await call('/v1/videos', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test', 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  assert.deepEqual(Array.from(new Uint8Array(captured.init.body)), Array.from(bytes));
});

await t('GET /v1/videos/op_1 → 视频轮询透传', async () => {
  await call('/v1/videos/op_1', { method: 'GET', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(captured.url, `${UPSTREAM}/videos/op_1`);
});

await t('POST /v1/batches → 透传', async () => {
  const body = JSON.stringify({ input_file_id: 'file-1', endpoint: '/v1/chat/completions', completion_window: '24h' });
  await call('/v1/batches', { method: 'POST', headers: { authorization: 'Bearer gk-test' }, body });
  assert.equal(captured.url, `${UPSTREAM}/batches`);
});

await t('GET /v1/batches/b_1 → 透传', async () => {
  await call('/v1/batches/b_1', { method: 'GET', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(captured.url, `${UPSTREAM}/batches/b_1`);
});

console.log('鉴权与查询串');

await t('无密钥 → 401 OpenAI 格式错误', async () => {
  const res = await call('/v1/chat/completions', { method: 'POST', body: '{"messages":[]}' });
  assert.equal(res.status, 401);
  const { error } = await res.json();
  assert.equal(error.code, 'missing_api_key');
  assert.equal(error.type, 'invalid_request_error');
});

await t('x-goog-api-key 头也能取到密钥', async () => {
  await call('/v1/models', { method: 'GET', headers: { 'x-goog-api-key': 'gk-alt' } });
  assert.equal(captured.init.headers.authorization, 'Bearer gk-alt');
});

await t('?key= 可用于鉴权；查询串一律不转发（Google 对未知参数硬报错）', async () => {
  await call('/v1/models?key=gk-query&foo=bar', { method: 'GET' });
  assert.equal(captured.init.headers.authorization, 'Bearer gk-query');
  assert.equal(captured.url, `${UPSTREAM}/models`);
});

console.log('校验与错误');

await t('messages 缺失 → 400，不打上游', async () => {
  captured = null; // 清掉上一用例的残留请求，才能断言"没打上游"
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test' },
    body: '{"model":"x"}',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'missing_messages');
  assert.equal(captured, null);
});

await t('非法 JSON → 400', async () => {
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test' },
    body: '{oops',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_json');
});

await t('空 messages 数组合法，放行给 Google 裁决', async () => {
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test' },
    body: '{"messages":[]}',
  });
  assert.equal(res.status, 200);
  assert.equal(captured.url, `${UPSTREAM}/chat/completions`);
});

await t('未知路径 → 404 OpenAI 格式', async () => {
  const res = await call('/v1/foo/bar', { method: 'POST' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
});

await t('方法不设白名单：GET chat/completions 也由上游裁决', async () => {
  const res = await call('/v1/chat/completions', { method: 'GET', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(res.status, 200);
  assert.equal(captured.url, `${UPSTREAM}/chat/completions`);
});

await t('HEAD /v1/models → 透传', async () => {
  await call('/v1/models', { method: 'HEAD', headers: { authorization: 'Bearer gk-test' } });
  assert.equal(captured.init.method, 'HEAD');
});

await t('上游网络故障 → 502 OpenAI 格式', async () => {
  upstreamMode = 'network_error';
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test' },
    body: '{"messages":[{"role":"user","content":"hi"}]}',
  });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'upstream_unreachable');
  upstreamMode = 'json';
});

await t('上游挂起（非流式）→ 等待响应头超时 504 upstream_timeout', async () => {
  upstreamMode = 'hang';
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test', 'content-type': 'application/json' },
    body: '{"messages":[{"role":"user","content":"hi"}]}',
  });
  assert.equal(res.status, 504);
  const { error } = await res.json();
  assert.equal(error.code, 'upstream_timeout');
  assert.equal(error.type, 'api_error');
  upstreamMode = 'json';
});

await t('上游挂起（流式）→ 走流式超时档快速 504', async () => {
  upstreamMode = 'hang';
  const started = Date.now();
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test', 'content-type': 'application/json' },
    body: '{"messages":[{"role":"user","content":"hi"}],"stream":true}',
  });
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error.code, 'upstream_timeout');
  assert.ok(Date.now() - started < 1000, '流式应走 150ms 档，而不是非流式 1200ms 档');
  upstreamMode = 'json';
});

await t('上游预填充 400 → 附加结构化 code=prefill_unsupported', async () => {
  upstreamMode = 'prefill_error';
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test', 'content-type': 'application/json' },
    body: '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"pre"}]}',
  });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.equal(error.code, 'prefill_unsupported');
  assert.match(error.message, /ending with a model turn/);
  assert.equal(error.type, 'invalid_request_error'); // 其余字段一律不动
  assert.equal(error.param, null);
  upstreamMode = 'json';
});

await t('上游 400 但非已知错误 → 原样透传，code 未被改动', async () => {
  upstreamMode = 'plain400';
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gk-test', 'content-type': 'application/json' },
    body: '{"messages":[{"role":"user","content":"hi"}]}',
  });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.equal(error.message, 'some other upstream failure');
  assert.equal(error.code, null);
  assert.equal(error.param, null);
  upstreamMode = 'json';
});

await t('OPTIONS 预检 → 204 + CORS（动词与头均通配）', async () => {
  const res = await call('/v1/anything', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-methods'), '*');
  assert.equal(res.headers.get('access-control-allow-headers'), '*');
  assert.ok(Number(res.headers.get('access-control-max-age')) >= 86400);
});

globalThis.fetch = realFetch;
console.log(`\n全部 ${passed} 项断言通过 ✔`);
