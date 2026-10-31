// Netlify Functions 的单函数体积上限是 250 MB（解压后）。
// @waline/vercel 默认会带上 MathJax 全套字体（约 100 MB）和 LeanCloud 实时通信
// SDK（约 22 MB），而本站用的是 PostgreSQL + KaTeX，这两块根本用不到，
// 不删就会直接超限导致部署失败（HTTP 400: function exceeds the maximum size of 250 MB）。
//
// 注意：@waline/vercel 的 src/config/config.js 会在模块加载时读取 MARKDOWN_TEX，
// 因此 netlify/functions/comment.js 里先把默认值设成 katex，MathJax 的
// 动态 import 分支就不会执行，删掉这两个包是安全的。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REMOVABLE = [
  '@mathjax', // MathJax 字体与运行时代码，约 100 MB
  '@mdit/plugin-mathjax', // 仅在 MARKDOWN_TEX=mathjax 时动态 import
  'speech-rule-engine', // MathJax 的可访问性语音引擎，约 9 MB
  'leancloud-realtime', // LeanCloud 实时通信，Waline 只用 leancloud-storage 存数据
];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'node_modules');

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // 忽略指向不存在目标的软链接
        }
      }
    }
  }
  return total;
}

let freed = 0;
for (const name of REMOVABLE) {
  const target = path.join(root, name);
  if (!fs.existsSync(target)) {
    continue;
  }
  const before = dirSize(target);
  fs.rmSync(target, { recursive: true, force: true });
  freed += before;
  console.log(`[prune] removed ${name} (${(before / 1024 / 1024).toFixed(1)} MB)`);
}

const total = dirSize(root);
console.log(`[prune] freed ${(freed / 1024 / 1024).toFixed(1)} MB, node_modules now ${(total / 1024 / 1024).toFixed(1)} MB`);
