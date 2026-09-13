export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const auth = req.headers.get('authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim();
  if (!key) return new Response('no api key', { status: 401 });

  const body = await req.json();

  // ① 删掉 Gemini 不认的参数 —— 解决你的 400 参数报错
  delete body.frequency_penalty;
  delete body.presence_penalty;
  delete body.logprobs;
  delete body.top_logprobs;
  delete body.logit_bias;
  if (body.penalty_score != null) delete body.penalty_score;

  // ② 保证最后一条不是 assistant/model —— 解决 "ending with a model turn"
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const last = msgs[msgs.length - 1];
    if (last && (last.role === 'assistant' || last.role === 'model')) {
      msgs.pop();
    }
    // 顺手兜底：空消息数组也会 400
    if (!msgs.length) msgs.push({ role: 'user', content: 'hi' });
  }

  // ③ 转发到谷歌的 OpenAI 兼容口
  const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  const headers = new Headers(req.headers);
  headers.set('authorization', `Bearer ${key}`);
  headers.delete('host');
  headers.delete('content-length');

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

