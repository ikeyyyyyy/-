/**
 * 跨版本测试入口。
 *
 * 为什么不用 `node --test` 加 glob 通配（形如 tests 目录下所有 test 文件）：
 *   - Node 20 不展开 glob，会直接报 "Could not find ..."；
 *   - Node 22 会把位置参数当模块路径，传目录 `tests` 会报 MODULE_NOT_FOUND。
 * 两边行为相反，所以这里自己递归找出测试文件，再把「明确文件列表」交给 --test，
 * 20 / 22 都能跑，命令行参数（可选目录）也保持一致。
 *
 * 用法：
 *   node scripts/run-tests.mjs                 # 跑 tests/ 下全部
 *   node scripts/run-tests.mjs tests/analytics # 只跑某个目录
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.(test|spec)\.(m?js)$/;

async function collect(target) {
  const abs = path.resolve(ROOT, target);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    console.error(`[test] 路径不存在：${target}`);
    process.exit(1);
  }

  if (stat.isFile()) return TEST_FILE.test(abs) ? [abs] : [];

  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    out.push(...await collect(path.join(target, e.name)));
  }
  return out;
}

const targets = process.argv.slice(2);
const files = [];
for (const t of (targets.length ? targets : ['tests'])) files.push(...await collect(t));

if (!files.length) {
  console.error('[test] 没有找到任何 *.test.js');
  process.exit(1);
}

const rel = files.map(f => path.relative(ROOT, f));
console.log(`[test] ${rel.length} 个测试文件 · Node ${process.version}\n`);

const child = spawn(process.execPath, ['--test', ...rel], { cwd: ROOT, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
