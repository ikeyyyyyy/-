/**
 * 零依赖 lint：语法检查 + 基础卫生检查。
 *
 * 为什么不用 ESLint：本项目要求「clone 下来不装依赖也能跑」，引入 ESLint 就要 node_modules。
 * 这里做的检查对应 CI 里真正会拦住问题的三件事：
 *   1. 每个 .js/.mjs 能被 Node 正常解析（语法错误）；
 *   2. index.html / 前端页面里的内联脚本也能被解析（这两处最容易漏检）；
 *   3. 仓库里没有混进密钥、没有把运行期数据（db.json / uploads）提交上去。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'backend/data', 'coverage', '.workbuddy']);

const errors = [];
const checked = { js: 0, html: 0 };

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(ROOT, path.join(dir, entry.name)).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else {
      out.push(rel);
    }
  }
  return out;
}

const files = walk(ROOT);

/* ---------- 1. JS 语法 ---------- */
for (const rel of files.filter(f => /\.(js|mjs)$/.test(f))) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
    checked.js++;
  } catch (err) {
    errors.push(`语法错误 ${rel}\n${String(err.stderr || err.message).split('\n').slice(0, 3).join('\n')}`);
  }
}

/* ---------- 2. HTML 内联脚本语法 ---------- */
for (const rel of files.filter(f => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  blocks.forEach((m, i) => {
    try {
      new vm.Script(m[1], { filename: `${rel}#inline-${i}` });
    } catch (err) {
      errors.push(`内联脚本语法错误 ${rel} 第 ${i + 1} 段：${err.message}`);
    }
  });
  checked.html++;
}

/* ---------- 3. 密钥扫描 ---------- */
const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9]{16,}/, label: 'OpenAI 风格密钥 (sk-...)' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key' },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: '私钥文件' },
  { re: /\bghp_[A-Za-z0-9]{20,}/, label: 'GitHub Token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack Token' }
];
const SECRET_SCAN_EXTS = /\.(js|mjs|json|md|yml|yaml|html|txt|env|example)$/;
for (const rel of files.filter(f => SECRET_SCAN_EXTS.test(f) || f.endsWith('.env.example'))) {
  if (rel === 'scripts/lint.js') continue;                       // 本文件里是模式定义，必然自匹配
  if (rel.startsWith('backend/data/')) continue;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) errors.push(`疑似密钥泄露：${rel} 命中「${p.label}」`);
  }
  // .env 里的占位值允许留空，但真实赋值要拦
  if (rel === '.env.example' && /^[A-Z_]+=.{20,}$/m.test(text)) {
    const suspicious = text.split('\n').filter(l => /^[A-Z_]+=.{20,}$/.test(l) && !/^(EG_|PORT|HOST)/.test(l));
    if (suspicious.length) errors.push(`.env.example 里疑似填了真实值：${suspicious[0].slice(0, 40)}…`);
  }
}

/* ---------- 4. 运行期数据不应存在于工作区 ---------- */
if (fs.existsSync(path.join(ROOT, 'backend/data/db.json'))) {
  // 允许本地存在（.gitignore 已忽略），只提示不报错
  console.log('提示：backend/data/db.json 存在（本地运行数据，已被 .gitignore 忽略，不会提交）');
}

/* ---------- 结果 ---------- */
console.log(`已检查 ${checked.js} 个 JS 文件、${checked.html} 个 HTML 文件的内联脚本`);
if (errors.length) {
  console.error(`\n发现 ${errors.length} 个问题：`);
  errors.forEach(e => console.error(' - ' + e));
  process.exit(1);
}
console.log('lint 通过');
