/**
 * 单文件版构建回归测试。
 *
 * 目的：README 的「方式 E」承诺「发一个 HTML 文件给对方，双击就能用」。
 * 这个承诺很容易被后续改动打破（比如有人在 index.html 里又加一个 CDN 外链，
 * 或者改掉 Chart.js 的 script 标签写法，构建脚本的字符串替换就会静默失效）。
 * 所以这里实际跑一遍构建，并检查产物的三条硬性约束。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(root, 'dist', '英语作文智能批阅-单文件版.html');

test('单文件版构建：产物存在且不含任何外部资源', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-standalone.mjs')], {
    cwd: root,
    stdio: 'pipe',
  });

  assert.ok(fs.existsSync(OUT), '构建产物不存在');
  const html = fs.readFileSync(OUT, 'utf8');

  // 1. 不允许任何 http(s) 的 src / href（离线可用的前提）
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, [], `产物仍引用外部资源：${external.join(', ')}`);

  // 2. Chart.js 必须是内联的，且确实是 4.4.1
  assert.ok(html.includes('Chart.js 4.4.1'), '缺少内联 Chart.js 的注释标记');
  assert.ok(html.includes('chart.umd.min.js') === false, '仍通过文件名外链 Chart.js');
  assert.match(html, /static version="4\.4\.1"/, '内联的 Chart.js 版本不是 4.4.1');

  // 3. 需要后端的两个入口不应出现在产物里
  assert.ok(!html.includes('data-page="multimodal"'), '图片批改入口未被移除');
  assert.ok(!html.includes('data-page="profile"'), '学习档案入口未被移除');

  // 4. 体积上限：单文件不能大到发不出去（当前约 300 KB）
  const kb = Buffer.byteLength(html) / 1024;
  assert.ok(kb < 700, `产物 ${kb.toFixed(0)} KB，超过 700 KB 上限`);
});
