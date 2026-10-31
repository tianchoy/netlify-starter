// @waline/admin 只发布一个浏览器端单文件 bundle（ESM IIFE，约 660 KB）。
// Netlify 函数没法直接吐静态资源，所以构建时把它拷到仓库根的 admin-ui.js，
// 由 netlify/functions/comment.js 在 /ui 路径下内联成 HTML 返回。
// 注意不要放进 netlify/functions/ —— 该目录下每个 .js 都会被当成一个函数部署。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const source = path.join(root, 'node_modules', '@waline', 'admin', 'dist', 'admin.js');
const target = path.join(root, 'admin-ui.js');

if (!fs.existsSync(source)) {
  console.error('[copy-admin] @waline/admin bundle not found, skip');
  process.exit(0);
}

fs.copyFileSync(source, target);
console.log(
  `[copy-admin] admin-ui.js ready (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`,
);
