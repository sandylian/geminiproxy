export const config = { runtime: 'edge' };

export default async function handler(req) {
  const auth = req.headers.get('authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim();
  if (!key) return new Response('no api key', { status: 401 });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
  const data = await res.json();

  // 把 Google 格式转成 OpenAI 格式
  const openaiFormat = {
    object: 'list',
    data: (data.models || []).map(m => ({
      id: m.name.replace('models/', ''),
      object: 'model',
      created: 0,
      owned_by: 'google'
    }))
  };

  return new Response(JSON.stringify(openaiFormat), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
