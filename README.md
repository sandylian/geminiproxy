# geminiproxy

把 Google Gemini API 转成 OpenAI 兼容接口的极简代理（Vercel Edge Functions）。

所有请求**原样透传**到 Google 官方 OpenAI 兼容层 `generativelanguage.googleapis.com/v1beta/openai/`，
不做格式转换、不清洗参数、不存储任何数据。API Key 由客户端携带，仅用于转发给 Google。

## 接入

- **Base URL**：`https://<你的域名>/v1`
- **API Key**：你自己的 Gemini API Key（[AI Studio → Get API key](https://aistudio.google.com/apikey)）
- 兼容不带 `/v1` 前缀的客户端（`/chat/completions`、`/models[/{id}]`、`/embeddings`、`/images/generations`、`/videos[/{id}]`、`/batches[/{id}]` 已做重写）
- 密钥传递方式：`Authorization: Bearer <key>` 优先，兼容 `x-goog-api-key` / `api-key` / `x-api-key` 头及 `?key=` 查询参数；无论哪种方式，密钥都不会出现在转发给上游的 URL 里

## 端点

| 端点 | 方法 | 上游 |
| --- | --- | --- |
| `/v1/chat/completions` | POST | `/v1beta/openai/chat/completions` |
| `/v1/models[/{id}]` | GET | `/v1beta/openai/models`（`models/` 前缀 id 也可整段透传） |
| `/v1/embeddings` | POST | `/v1beta/openai/embeddings` |
| `/v1/images/generations` | POST | `/v1beta/openai/images/generations` |
| `/v1/videos[/{id}]` | POST / GET | `/v1beta/openai/videos`（Sora 兼容，veo-3.1；创建 + 轮询） |
| `/v1/batches[/{id}]` | POST / GET | `/v1beta/openai/batches`（文件上传/下载上游不支持） |

HTTP 方法不做本地白名单，方法对错一律由上游裁决（404/405 原样透传）。

## 示例

```bash
curl https://<你的域名>/v1/chat/completions \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"你好"}]}'
```

```python
from openai import OpenAI

client = OpenAI(api_key="你的 GEMINI_API_KEY", base_url="https://<你的域名>/v1")
resp = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

## 说明

- **思考控制**：`reasoning_effort` 或 `extra_body.google.thinking_config` 原样透传即生效，代理层无需任何处理。
- **预填充限制**：消息以 assistant 结尾时 Google 返回 400（官方行为），错误原样透传给客户端。
- **透传保真**：content-type 原样透传、请求体二进制安全（视频 `-F` multipart 上传可用）。
- **参数清洗**：`frequency_penalty`、`presence_penalty`、`logprobs`、`top_logprobs`、`logit_bias` 五个 OpenAI 字段会被剥掉——实测 Google 兼容层对它们返回 400（Unknown name / Cannot find field）。以后遇到新的 `Unknown name "X"` 报错，把 X 补进 `api/_handler.js` 的 `STRIP_FIELDS` 即可；除这五个字段外，其余（含预填充、`reasoning_effort`、`extra_body.google.*`）全部原样透传。
- **错误格式**：本地校验错误（401/400/404/502）返回 OpenAI 标准错误结构；上游错误原样透传。
- **CORS**：全端点开放，浏览器端可直连；OPTIONS 预检 204 并带 `Access-Control-Max-Age: 86400`。
- **加新端点**：在 `api/_handler.js` 的 `ROUTES` 里加一行；同时为该路径添加一个两行的入口文件（参考 `api/v1/` 下现有文件的写法），双保险路由。

## 开发

```bash
npm test   # 本地路由测试（不访问网络，Node 18+）
```

## 部署

Vercel 项目根目录部署即可（`vercel --prod` 或 Git 推送）。Edge Runtime，流式透传，免费额度内自用绰绰有余。
