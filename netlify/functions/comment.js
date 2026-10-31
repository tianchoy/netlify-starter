const http = require('http');
const Waline = require('@waline/vercel');
const serverless = require('serverless-http');

// Waline 的 netlify 路由前缀是从运行时环境变量 _HANDLER 推导的
// （见 @waline/vercel/src/config/netlify.js）。该变量在部分 Netlify
// 运行时下缺失或格式不符，前缀就会错位，导致所有请求 404。
// 它的路由前缀数组里始终包含朴素的 /api，所以这里主动把函数路径
// 前缀剥掉，让 Waline 收到 /api/xxx 即可正常匹配。
const FUNCTION_PREFIX = '/.netlify/functions/comment';

const app = Waline({
  env: 'netlify',
  async postSave(comment) {
    // do what ever you want after save comment
  },
});

const handler = serverless(http.createServer(app));

const stripPrefix = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  const index = value.indexOf(FUNCTION_PREFIX);
  if (index === -1) {
    return value;
  }
  // rawUrl 是完整 URL（https://site/.netlify/...），path 只是路径，
  // 统一从函数前缀之后截断，保留 query string
  const rest = value.slice(index + FUNCTION_PREFIX.length);
  return rest.length === 0 ? '/' : rest;
};

module.exports.handler = (event, context) =>
  handler(
    {
      ...event,
      path: stripPrefix(event.path),
      rawPath: stripPrefix(event.rawPath),
      rawUrl: stripPrefix(event.rawUrl),
    },
    context,
  );
