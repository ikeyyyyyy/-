/**
 * 页面互相跳转的回归检查（纯静态，不需要浏览器）。
 *
 * 背景：IDE 预览面板用 <iframe srcdoc> 渲染 HTML，文档地址是 about:srcdoc，
 * 相对链接的基准会变成宿主页面地址 —— 直接写 <a href="../../../../index.html">
 * 在面板里点了没反应。所以三个页面之间的跳转必须带 data-page，并走兼容函数。
 *
 * 这个测试保证三件事：
 *   1) 所有跨页入口都带 data-page（否则点击事件不会接管，又会退回裸相对链接）；
 *   2) 兼容逻辑还在（isOpaqueDoc / originFromBaseURI / PAGE_ROUTES）；
 *   3) PAGE_ROUTES 里写的仓库内路径都真实存在（改文件名忘了改路由会立刻失败）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/server.js';

const PAGES = {
  grading: 'index.html',
  multimodal: 'frontend/src/pages/MultimodalUpload/index.html',
  profile: 'frontend/src/pages/LearningProfile/index.html'
};

const read = rel => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

test('每个跨页入口都带 data-page，且没有漏网的裸相对链接', () => {
  const cases = [
    { page: 'grading', targets: ['multimodal', 'profile'] },
    { page: 'multimodal', targets: ['grading', 'profile'] },
    { page: 'profile', targets: ['grading', 'multimodal'] }
  ];

  for (const { page, targets } of cases) {
    const html = read(PAGES[page]);
    for (const target of targets) {
      assert.match(
        html,
        new RegExp(`data-page="${target}"`),
        `${PAGES[page]} 缺少指向 ${target} 的 data-page 入口`
      );
    }

    // 跨页链接必须带 data-page：找到所有形如 href="...index.html" 的锚点逐个核对
    const anchors = html.match(/<a\b[^>]*href="[^"]*index\.html[^"]*"[^>]*>/g) || [];
    const crossPage = anchors.filter(tag => !/href="[^"]*:\/\//.test(tag)); // 排除外链
    for (const tag of crossPage) {
      assert.match(tag, /data-page="/, `${PAGES[page]} 里有未接管的相对链接：${tag}`);
    }
  }
});

test('三个页面都保留 srcdoc 兼容逻辑', () => {
  for (const rel of Object.values(PAGES)) {
    const html = read(rel);
    assert.match(html, /function isOpaqueDoc\(/, `${rel} 缺少 isOpaqueDoc`);
    assert.match(html, /srcdoc|about:srcdoc/, `${rel} 缺少 srcdoc 相关说明`);
  }
  for (const rel of [PAGES.multimodal, PAGES.profile]) {
    const html = read(rel);
    assert.match(html, /function originFromBaseURI\(/, `${rel} 缺少 baseURI 兜底`);
    assert.match(html, /PAGE_ROUTES/, `${rel} 缺少 PAGE_ROUTES 路由表`);
  }
});

test('路由表里的仓库内路径都存在', () => {
  for (const rel of Object.values(PAGES)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} 不存在`);
  }

  // 从三份路由表里抽出 path: '/xxx'，逐个核对磁盘文件
  const declared = new Set();
  for (const rel of Object.values(PAGES)) {
    const html = read(rel);
    for (const m of html.matchAll(/path:\s*'\/([^']+)'/g)) declared.add(m[1]);
  }
  assert.ok(declared.size >= 3, '路由表解析异常');
  for (const p of declared) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, p)), `路由指向的文件不存在：/${p}`);
  }
});
