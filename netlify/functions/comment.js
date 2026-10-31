// 必须在 require('@waline/vercel') 之前设置：它的 src/config/config.js 在模块
// 加载阶段就会读取 MARKDOWN_TEX，默认值 mathjax 会连带加载 100 MB 的 MathJax。
// 这里默认改用 KaTeX（体积只有几 MB），构建时 scripts/prune.mjs 才有条件把
// MathJax 从函数包里删掉，否则会超过 Netlify 的单函数 250 MB 限制。
process.env.MARKDOWN_TEX = process.env.MARKDOWN_TEX || 'katex';

const http = require('http');
const Waline = require('@waline/vercel');
const serverless = require('serverless-http');

// Waline 的路由前缀是从运行时环境变量 _HANDLER 推导的
// （见 @waline/vercel/src/config/netlify.js），该变量在不同运行时下
// 可能缺失或格式不符，前缀一旦错位所有请求都会 404。
// Waline 的路由前缀列表里始终包含朴素的 /api，所以这里统一把
// /.netlify/functions/<函数名> 这段剥掉，让它收到 /api/xxx。
const FUNCTION_MARK = '/.netlify/functions/';

// 可能承载「原始路径」的请求头，按可信度排序
const PATH_HEADERS = [
  'x-nf-original-path',
  'x-original-uri',
  'x-forwarded-uri',
  'x-rewrite-url',
  'x-nf-request-path',
];

function stripQuery(value) {
  const index = value.indexOf('?');
  return index === -1 ? value : value.slice(0, index);
}

function toRouterPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  let path = value;
  if (/^https?:\/\//iu.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = path.replace(/^https?:\/\/[^/]+/iu, '');
    }
  }
  path = stripQuery(path);

  const markIndex = path.indexOf(FUNCTION_MARK);
  if (markIndex !== -1) {
    // 去掉 /.netlify/functions/ 和紧随其后的函数名
    const rest = path.slice(markIndex + FUNCTION_MARK.length);
    const slashIndex = rest.indexOf('/');
    path = slashIndex === -1 ? '/' : rest.slice(slashIndex);
  }

  return path.length === 0 ? '/' : path;
}

function buildQuery(event) {
  if (typeof event.rawQueryString === 'string' && event.rawQueryString.length > 0) {
    return event.rawQueryString;
  }
  const query = event.queryStringParameters || {};
  return Object.keys(query)
    .filter((key) => query[key] !== undefined && query[key] !== null)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
    .join('&');
}

// 依次尝试所有可能来源，取第一个能解析出 /api 或 /ui 的路径
function resolvePath(event) {
  const headers = event.headers || {};
  const candidates = [
    event.rawUrl,
    event.rawPath,
    ...PATH_HEADERS.map((key) => headers[key] || headers[key.toUpperCase()]),
    event.path,
    event.requestContext && event.requestContext.path,
  ]
    .map(toRouterPath)
    .filter((value) => typeof value === 'string');

  return candidates.find((value) => value === '/ui' || value.startsWith('/ui/') || value === '/api' || value.startsWith('/api/')) || candidates[0] || '/';
}

function normalize(event) {
  const headers = event.headers || {};
  const host = headers.host || headers.Host || 'localhost';
  const path = resolvePath(event);
  const query = buildQuery(event);
  const rawUrl = `https://${host}${path}${query ? `?${query}` : ''}`;

  return {
    ...event,
    path,
    rawPath: path,
    rawUrl,
    rawQuery: query,
    rawQueryString: query,
  };
}

const app = Waline({
  env: 'netlify',
  async postSave(comment) {
    // do what ever you want after save comment
  },
});

const handler = serverless(http.createServer(app));

module.exports.handler = (event, context) => {
  // 诊断入口：带 ?__probe=1 时回显 Netlify 实际传入的事件，
  // 用来定位路径差异，确认无误后可整段删掉。
  const query = buildQuery(event);
  if (/(^|&)__probe=1(&|$)/u.test(query)) {
    const detail = {
      version: event.version || '1.0',
      handlerEnv: process.env._HANDLER || null,
      eventKeys: Object.keys(event),
      originalPath: event.path,
      originalRawPath: event.rawPath,
      originalRawUrl: event.rawUrl,
      requestContextPath: event.requestContext && event.requestContext.path,
      headers: Object.keys(event.headers || {}).reduce((acc, key) => {
        if (key.toLowerCase() === 'cookie') {
          return acc;
        }
        acc[key] = event.headers[key];
        return acc;
      }, {}),
      resolvedPath: resolvePath(event),
    };
    console.log('[waline-probe]', JSON.stringify(detail));
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(detail, null, 2),
    };
  }

  return handler(normalize(event), context);
};
