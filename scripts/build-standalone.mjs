/**
 * 生成「单文件版」HTML：把 Chart.js 内联进页面、去掉所有外部依赖。
 *
 * 用途：把 index.html 通过 QQ / 微信 发给不装 Node 的人，双击就能看完整界面
 *      （含雷达图），不需要网络、不需要后端、不需要解压整个仓库。
 *
 * 注意：单文件版只包含「文本批改」页。图片批改与学习档案两页依赖本地 Node 服务，
 *      无法单文件化，所以在构建时把这两个入口隐藏，避免对方点进死链接。
 *
 * 用法：node scripts/build-standalone.mjs
 * 产物：dist/英语作文智能批阅-单文件版.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'index.html');
const CHART = path.join(root, 'assets', 'vendor', 'chart.umd.min.js');
const OUT_DIR = path.join(root, 'dist');
const OUT = path.join(OUT_DIR, '英语作文智能批阅-单文件版.html');

/** 断言替换成功，避免源文件改动后静默产出残缺页面 */
function mustReplace(html, from, to, label) {
  if (!html.includes(from)) {
    throw new Error(`构建失败：源文件里找不到「${label}」，index.html 可能已改动`);
  }
  return html.replace(from, to);
}

let html = fs.readFileSync(SRC, 'utf8');
const chartSrc = fs.readFileSync(CHART, 'utf8');

// 1) 去掉 Tailwind CDN（页面关键样式都在内联 CSS 里，只有顶栏一行用到工具类，
//    那行已另外补了 .tag-row，所以单文件版可以完全不依赖 CDN）
html = mustReplace(
  html,
  '<!-- ===== Tailwind CSS（仅用于个别工具类；取不到也不影响布局） ===== -->\n<script src="https://cdn.tailwindcss.com"></script>\n',
  '<!-- 单文件版：不加载 Tailwind CDN（关键样式已内联） -->\n',
  'Tailwind CDN 标签',
);

// 2) Chart.js 由外链改为内联
html = mustReplace(
  html,
  `<!-- ===== Chart.js 4.4.1（雷达图）：优先生效的本地副本，断网/校园网拦截 CDN 也能出图 ===== -->
<script src="assets/vendor/chart.umd.min.js"
        onerror="var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';document.head.appendChild(s);"></script>`,
  `<!-- ===== Chart.js 4.4.1（已内联，单文件版零外部依赖） ===== -->
<script>${chartSrc}</script>`,
  'Chart.js 外链标签',
);

// 3) 隐藏两个需要后端的入口（单文件版里点进去没有东西）
html = mustReplace(
  html,
  `      <a class="tag tag-link" href="frontend/src/pages/MultimodalUpload/index.html" target="_blank" rel="noopener" data-page="multimodal">📷 图片/PDF 批改</a>
      <a class="tag tag-link" href="frontend/src/pages/LearningProfile/index.html" target="_blank" rel="noopener" data-page="profile">📈 学习档案</a>
`,
  `      <!-- 单文件版：图片批改 / 学习档案需要本地 Node 服务，故不在此版本中提供入口 -->
`,
  '页面顶部两个模块入口',
);

// 4) 顺带把「学习档案」框里的死链也降级成纯文字（该框在单文件版里是隐藏的，
//    但保留 <a href> 会让「产物不该有跨页入口」的检查失效）
html = mustReplace(
  html,
  '<a id="linkProfile" class="mini-link" href="frontend/src/pages/LearningProfile/index.html" target="_blank" rel="noopener" data-page="profile">查看档案 →</a>',
  '<span class="mini-link">查看档案 →</span>',
  '学习档案框内的链接',
);

// 5) 隐藏「学习档案」可选框（它要连 127.0.0.1:8787，单文件版里只会显示未连接）
html = mustReplace(
  html,
  '<style>\n',
  '<style>\n  /* 单文件版：学习档案需本地服务，隐藏以免出现「未连接」提示 */\n  #profileBox{display:none !important;}\n',
  '<style> 起始标签',
);

// 6) 一次性检查：确认没有残留的外部资源
const leftovers = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
if (leftovers.length) {
  throw new Error(`构建失败：仍残留外部资源 ${leftovers.join(', ')}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`已生成：${path.relative(root, OUT)}`);
console.log(`  大小 ${kb(Buffer.byteLength(html))}（其中 Chart.js 内联 ${kb(chartSrc.length)}）`);
console.log('  外部依赖：0 个（可离线双击打开）');
