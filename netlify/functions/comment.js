// 必须在 require('@waline/vercel') 之前设置：它的 src/config/config.js 在模块
// 加载阶段就会读取 MARKDOWN_TEX，默认值 mathjax 会连带加载 100 MB 的 MathJax。
// 这里默认改用 KaTeX（体积只有几 MB），构建时 scripts/prune.mjs 才有条件把
// MathJax 从函数包里删掉，否则会超过 Netlify 的单函数 250 MB 限制。
process.env.MARKDOWN_TEX = process.env.MARKDOWN_TEX || 'katex';

const fs = require('fs');
const path = require('path');
const http = require('http');
const serverless = require('serverless-http');

// @waline/vercel 不含管理后台（Vercel 模板靠额外的 @waline/admin 提供），
// 所以这里自建一层：命中 /ui 时直接吐出 @waline/admin 的单文件 SPA。
// 构建时 scripts/copy-admin.mjs 会把 bundle 拷成仓库根的 admin-ui.js。
//
// 这里不要注入任何操作 DOM 的脚本：后台是 React 管理的，外部删节点会让下一次
// diff 抛 NotFoundError 并卸载整棵树（页面「闪一下就白屏」）。此前为隐藏无关的
// LeanCloud 公告加过 MutationObserver，现已删除 —— @waline/admin 0.36.1 配合
// @waline/vercel 1.43.6 返回的 storage 字段，只会在 LeanCloud 存储下显示该公告。
const FUNCTION_NAME = (process.env._HANDLER || 'comment.handler').replace(/\.handler$/u, '');
// 后台所有请求都是 ${serverURL}<相对路径>（如 `comment?type=list`、`user`、`token/2fa`），
// 而它要求响应必须带 errno:0 —— 只有 /api/ 前缀的接口才是这个包装格式，
// 少给 api/ 段会拿到裸的分页对象，后台会因 errno !== 0 直接抛错、列表永远空白。
const SERVER_PREFIX = `/.netlify/functions/${FUNCTION_NAME}/api/`;

let adminBundle;
function getAdminBundle() {
  if (adminBundle === undefined) {
    const candidates = [
      path.join(__dirname, '..', '..', 'admin-ui.js'),
      path.join(process.cwd(), 'admin-ui.js'),
      path.join(__dirname, '..', '..', 'node_modules', '@waline', 'admin', 'dist', 'admin.js'),
    ];
    const found = candidates.find((file) => {
      try {
        return fs.statSync(file).size > 0;
      } catch {
        return false;
      }
    });
    adminBundle = found ? fs.readFileSync(found, 'utf8') : null;
  }
  return adminBundle;
}

function adminPage() {
  const bundle = getAdminBundle();
  if (!bundle) {
    return json(
      500,
      { error: 'admin bundle not found (admin-ui.js missing in deployment)' },
    );
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>评论管理 · Waline</title>
</head>
<body>
<script>window.serverURL = ${JSON.stringify(SERVER_PREFIX)};</script>
<script type="module">${bundle}</script>
</body>
</html>`,
  };
}

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

  return (
    candidates.find(
      (value) => value === '/ui' || value.startsWith('/ui/') || value === '/api' || value.startsWith('/api/'),
    ) ||
    candidates[0] ||
    '/'
  );
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

// Waline 用 ThinkJS，启动时会扫描自身目录注册路由，初始化成本高且可能失败。
// 这里改成首次请求时才加载：这样探针、以及初始化失败时的错误详情都能正常返回，
// 而不是整个函数 502。
let walineHandler;
function getWalineHandler() {
  if (!walineHandler) {
    walineHandler = (async () => {
      const Waline = require('@waline/vercel');
      const app = Waline({
        env: 'netlify',
        async postSave(comment) {
          // do what ever you want after save comment
        },
      });
      return serverless(http.createServer(app));
    })();
  }
  return walineHandler;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload, null, 2),
  };
}

module.exports.handler = async (event, context) => {
  const query = buildQuery(event);

  // 诊断入口：带 ?__probe=1 时回显运行时信息，确认无误后可整段删掉。
  if (/(^|&)__probe=1(&|$)/u.test(query)) {
    return json(200, {
      node: process.version,
      versions: process.versions,
      handlerEnv: process.env._HANDLER || null,
      markdownTex: process.env.MARKDOWN_TEX || null,
      eventKeys: Object.keys(event),
      originalPath: event.path,
      originalRawUrl: event.rawUrl,
      resolvedPath: resolvePath(event),
    });
  }

  const routerPath = resolvePath(event);

  // 管理后台：所有 /ui 及 /ui/* 都返回同一个 SPA 页面（内部是前端路由）
  if (routerPath === '/ui' || routerPath.startsWith('/ui/')) {
    return adminPage();
  }

  try {
    const handler = await getWalineHandler();
    return await handler(normalize(event), context);
  } catch (error) {
    return json(500, {
      error: error && error.message,
      code: error && error.code,
      node: process.version,
      stack: error && error.stack ? String(error.stack).split('\n').slice(0, 6) : null,
    });
  }
};
