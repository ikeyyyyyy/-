/**
 * 生成多模态模块的演示图片（印刷体 / 模拟手写）。
 *
 * 设计原则：图片里的文字与 sample_data/ocr_fixtures/*.txt 完全一致——
 * 脚本从同一个 .txt 读取文本再渲染成图，因此"夹具文本 = 图片真实内容"，
 * 不存在"用假文本冒充识别结果"的情况。
 *
 * 用法：
 *   node scripts/make-sample-images.mjs
 *   BROWSER="/path/to/chrome" node scripts/make-sample-images.mjs
 *
 * 说明：
 *  - 手写样例是用手写体字体（Segoe Script / Ink Free）渲染的【模拟手写】，
 *    不是真实手写照片，仅用于验证"低置信度 -> needs_review"这条分支。
 *  - 渲染完成后需要重新生成夹具的 sha256（脚本会自动更新 index.json 的 sha256 字段）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'sample_data', 'ocr_fixtures');
const IMAGE_DIR = path.join(ROOT, 'sample_data', 'images');

const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const browser = CANDIDATES.find(p => fs.existsSync(p));
if (!browser) {
  console.error('未找到 Chrome / Edge，无法渲染样例图片。可用 BROWSER=/path/to/chrome 指定。');
  process.exit(1);
}

const JOBS = [
  {
    id: 'printed_sample',
    textFile: 'printed_sample.txt',
    width: 880,
    height: 1180,
    style: {
      fontFamily: "'Times New Roman', Georgia, 'Songti SC', serif",
      fontSize: '19px',
      lineHeight: 1.85,
      rotate: '0deg',
      paperBg: '#fdfdf9',
      ink: '#1f2937'
    }
  },
  {
    id: 'handwriting_sample',
    textFile: 'handwriting_sample.txt',
    width: 880,
    height: 620,
    style: {
      // 模拟手写：手写体字体 + 淡蓝横线纸 + 轻微倾斜
      fontFamily: "'Segoe Script', 'Ink Free', 'Bradley Hand', cursive",
      fontSize: '27px',
      lineHeight: 2.1,
      rotate: '-1.1deg',
      paperBg: '#fffdf5',
      ink: '#1e3a8a',
      ruled: true
    }
  }
];

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtml(text, style) {
  const paras = text.trim().split(/\n\s*\n/).map(p => `<p>${escapeHtml(p.replace(/\n/g, ' '))}</p>`).join('\n');
  const ruled = style.ruled
    ? `background-image: repeating-linear-gradient(transparent, transparent 56px, #dbeafe 56px, #dbeafe 57px);`
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#e5e7eb;}
  .page{
    width:100%;min-height:100vh;box-sizing:border-box;padding:56px 64px;
    background:${style.paperBg}; ${ruled}
    color:${style.ink};
    font-family:${style.fontFamily};
    font-size:${style.fontSize};
    line-height:${style.lineHeight};
    transform:rotate(${style.rotate});
    transform-origin:center top;
    box-shadow:inset 0 0 90px rgba(0,0,0,.05);
  }
  p{margin:0 0 1.05em;}
</style></head><body><div class="page">${paras}</div></body></html>`;
}

function shoot(htmlPath, pngPath, width, height) {
  return new Promise((resolve, reject) => {
    execFile(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--default-background-color=ffffffff',
        `--window-size=${width},${height}`,
        `--screenshot=${pngPath}`,
        '--virtual-time-budget=3000',
        `file:///${htmlPath.replace(/\\/g, '/')}`
      ],
      { timeout: 60000 },
      err => (err ? reject(err) : resolve())
    );
  });
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

await fsp.mkdir(IMAGE_DIR, { recursive: true });
const manifestPath = path.join(FIXTURE_DIR, 'index.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  : { fixtures: [] };

for (const job of JOBS) {
  const text = await fsp.readFile(path.join(FIXTURE_DIR, job.textFile), 'utf8');
  const htmlPath = path.join(os.tmpdir(), `eg_render_${job.id}.html`);
  const pngTmp = path.join(os.tmpdir(), `eg_render_${job.id}.png`);
  await fsp.writeFile(htmlPath, buildHtml(text, job.style), 'utf8');
  await shoot(htmlPath, pngTmp, job.width, job.height);

  const buf = await fsp.readFile(pngTmp);
  const outPath = path.join(IMAGE_DIR, `${job.id}.png`);
  await fsp.writeFile(outPath, buf);
  const hash = sha256(buf);

  const entry = manifest.fixtures.find(f => f.id === job.id);
  if (entry) entry.sha256 = hash;
  console.log(`${job.id}.png  ${buf.length} bytes  sha256=${hash.slice(0, 16)}…`);
}

await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('已更新夹具 manifest：', path.relative(ROOT, manifestPath));
