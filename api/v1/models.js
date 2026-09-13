export const config = { runtime: 'edge' };

export default async function handler(req) {
  const auth = req.headers.get('authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim();
  if (!key) return new Response('no api key', { status: 401 });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/openai/models?key=${key}`);
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

