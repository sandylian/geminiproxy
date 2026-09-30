// 共享处理逻辑：所有 api/v1/** 入口文件 re-export 这个 default。
// 下划线前缀的文件不会被 Vercel 当作路由，仅作为被导入的模块。
export const config = { runtime: 'edge' };

// Google 官方的 OpenAI 兼容层，请求原样透传，格式转换由 Google 完成。
// 本函数只负责：路径白名单、密钥提取、chat 最小校验、OpenAI 格式错误、CORS。
const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta/openai';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  // 非凭据请求下 * 合法（与 Allow-Headers: * 同一前提）：动词不设限，与"方法由上游裁决"一致
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// 加新端点 = 加一行。path 是 /v1/ 之后的相对路径；以 /* 结尾表示匹配该前缀下任意深度。
// 不设方法白名单：方法对错一律由上游裁决，本函数不做本地 405。
const ROUTES = [
  { path: 'chat/completions', upstream: () => `${UPSTREAM}/chat/completions`, validate: true },
  { path: 'embeddings', upstream: () => `${UPSTREAM}/embeddings` },
  { path: 'images/generations', upstream: () => `${UPSTREAM}/images/generations` },
  // 路径段原样透传：保留客户端编码，不二次 encode（pathname 已由 URL 解析器归一化，
  // 段内不含裸 / ? #；models 放开任意深度以支持 models/ 前缀 id 的 round-trip）
  { path: 'models/*', upstream: (p) => `${UPSTREAM}/models${p.rest}` },
  { path: 'videos/*', upstream: (p) => `${UPSTREAM}/videos${p.rest}` },
  { path: 'batches/*', upstream: (p) => `${UPSTREAM}/batches${p.rest}` },
];

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

// OpenAI SDK 只认这种错误结构
function openaiError(status, message, type = 'invalid_request_error', code = null) {
  return json(status, { error: { message, type, param: null, code } });
}

// Bearer 优先，向下兼容 x-goog-api-key / api-key / x-api-key / ?key= 的客户端
function extractKey(req, url) {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  for (const name of ['x-goog-api-key', 'api-key', 'x-api-key']) {
    const value = (req.headers.get(name) || '').trim();
    if (value) return value;
  }
  return (url.searchParams.get('key') || '').trim();
}

function matchRoute(segments) {
  const joined = segments.join('/');
  for (const route of ROUTES) {
    if (route.path.endsWith('/*')) {
      const prefix = route.path.slice(0, -2);
      if (segments[0] === prefix) {
        return { route, params: { rest: segments.length > 1 ? `/${segments.slice(1).join('/')}` : '' } };
      }
    } else if (route.path === joined) {
      return { route, params: {} };
    }
  }
  return null;
}

// OpenAI 有、而 Google 兼容层不收的字段：实测会 400（Unknown name ... Cannot find field），
// 转发前剥掉。以后遇到新的 "Unknown name "X"" 报错，把 X 补进这个名单即可。
const STRIP_FIELDS = ['frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs', 'logit_bias'];

// chat/completions 的本地处理：校验 messages 是数组 + 剥掉不兼容字段，其余原样保留
// （预填充、reasoning_effort、extra_body.google.* 等全部不动，由 Google 兼容层裁决）。
function sanitizeChatBody(raw) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { error: openaiError(400, '请求体不是合法 JSON', 'invalid_request_error', 'invalid_json') };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
    return { error: openaiError(400, '请求体必须包含 `messages` 数组', 'invalid_request_error', 'missing_messages') };
  }
  for (const field of STRIP_FIELDS) delete parsed[field];
  return { body: JSON.stringify(parsed) };
}

export default async function handler(req) {
  // 预检短路：不进路由；Max-Age 让浏览器缓存预检结果，减少调用次数
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  // 兼容重写后的 /api/v1/* 与直达的 /v1/* 两种形态
  const segments = url.pathname.replace(/^\/(api\/)?v1\/?/, '').split('/').filter(Boolean);
  const match = matchRoute(segments);

  if (!match) {
    return openaiError(404, `未知路径 /v1/${segments.join('/')}`, 'invalid_request_error', 'not_found');
  }

  const key = extractKey(req, url);
  if (!key) {
    return openaiError(401, '缺少 API Key：请以 `Authorization: Bearer <GEMINI_API_KEY>` 方式传入', 'invalid_request_error', 'missing_api_key');
  }

  // 查询串一律不转发：这些端点不需要任何查询参数，而 Google 对未知查询参数是硬报错
  // （Unknown name ... Cannot bind query parameter），客户端多带的参数在本地丢弃最稳。

  // 二进制安全透传：multipart（如视频 -F 上传）不经过字符串解码
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await req.arrayBuffer();
    } catch {
      return openaiError(400, '读取请求体失败', 'invalid_request_error', 'body_read_failed');
    }
    if (match.route.validate) {
      const sanitized = sanitizeChatBody(body);
      if (sanitized.error) return sanitized.error;
      body = sanitized.body;
    }
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(match.route.upstream(match.params), {
      method: req.method,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': req.headers.get('content-type') || 'application/json',
      },
      body,
    });
  } catch (err) {
    return openaiError(502, `请求 Google 上游失败：${err instanceof Error ? err.message : String(err)}`, 'api_error', 'upstream_unreachable');
  }

  // 上游响应（含预填充 400、限流 429 等错误）原样透传，只补 CORS 头
  const headers = new Headers(upstreamRes.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
}
