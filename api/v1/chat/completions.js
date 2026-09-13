export const config = { runtime: 'edge' };

export default async function handler(req) {
  // OPTIONS 预检直接 204，不进函数体，省调用次数
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    });
  }

  // 只允许 POST
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const auth = req.headers.get('authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim();
  if (!key) return new Response('no api key', { status: 401 });

  const body = await req.json();

  // ① 删掉 Gemini 不认的参数
  delete body.frequency_penalty;
  delete body.presence_penalty;
  delete body.logprobs;
  delete body.top_logprobs;
  delete body.logit_bias;
  if (body.penalty_score != null) delete body.penalty_score;

  // ② 保证最后一条不是 assistant/model
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const last = msgs[msgs.length - 1];
    if (last && (last.role === 'assistant' || last.role === 'model')) {
      msgs.pop();
    }
    if (!msgs.length) msgs.push({ role: 'user', content: 'hi' });
  }

  // ③ 转发到谷歌
  const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  const headers = new Headers(req.headers);
  headers.set('authorization', `Bearer ${key}`);
  headers.delete('host');
  headers.delete('content-length');

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // 转发响应时带上 CORS 头，浏览器端才能读到
  const respHeaders = new Headers(res.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  respHeaders.set('Access-Control-Allow-Headers', 'authorization, content-type');

  return new Response(res.body, {
    status: res.status,
    headers: respHeaders,
  });
}
