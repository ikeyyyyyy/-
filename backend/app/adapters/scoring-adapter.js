/**
 * 评分服务适配器（本项目的集成核心）。
 *
 * 为什么这样写：
 * 现有评分 / 评语 / 标准对齐逻辑全部在 index.html 的内联 <script> 里，
 * 本项目要求「不重写、不复制、不绕过」。所以这里不做任何公式搬运，
 * 而是把 index.html 的内联脚本原样读出来，放进 Node 的 vm 沙箱执行，
 * 再从沙箱里取出 analyzeEssay 等函数直接调用。
 *
 * 好处：
 *  - 零复制：评分公式只有一份，前端后端共用；改 index.html 里的系数，后端立刻跟着变。
 *  - 零破坏：不需要把单文件拆成模块，index.html 依然双击可跑。
 * 代价：
 *  - 沙箱需要 stub 掉 document / Chart 等浏览器全局（脚本里只在 DOM 回调中用到，不会被调用）。
 *  - 单次加载有开销，所以按文件 mtime 缓存；文件变更自动重新加载（开发时改完即生效）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { REPO_ROOT } from '../config.js';
import { AppError, ERR } from '../errors.js';

const ENGINE_FILE = path.join(REPO_ROOT, 'index.html');

let cache = null;

/** 浏览器全局的最小 stub：只满足脚本顶层代码的引用，不模拟真实 DOM */
function makeSandbox() {
  const noop = () => {};
  const fakeNode = {
    style: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    dataset: {},
    appendChild: noop,
    removeChild: noop,
    setAttribute: noop,
    addEventListener: noop,
    removeEventListener: noop,
    querySelectorAll: () => [],
    focus: noop,
    blur: noop,
    select: noop
  };
  const document = {
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,        // 脚本只在 DOMContentLoaded 回调里用，回调不会触发
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ ...fakeNode }),
    body: { ...fakeNode }
  };
  const localStorage = {
    getItem: () => null,
    setItem: noop,
    removeItem: noop
  };
  const window = { innerWidth: 1280, addEventListener: noop, removeEventListener: noop, localStorage };
  return {
    document,
    window,
    localStorage,
    navigator: { clipboard: null, userAgent: 'node-vm' },
    location: { href: 'file:///index.html', protocol: 'file:' },
    Chart: function ChartStub() { this.destroy = noop; },
    setTimeout,
    clearTimeout,
    console
  };
}

/** 从 index.html 中取出唯一的业务脚本（页面只有一个内联 <script> 块） */
function extractInlineScript(html) {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!matches.length) {
    throw new Error('index.html 中未找到内联 <script> 块，评分适配器无法加载');
  }
  // 取最长的一段：页面里没有其它 <script>，这样写可以容忍将来加入短小的埋点脚本
  return matches.sort((a, b) => b[1].length - a[1].length)[0][1];
}

/**
 * 加载引擎（带 mtime 缓存）。
 * @returns {{analyzeEssay:Function, EXAM_SYSTEMS:object, EXAM_ORDER:string[], DIM_ORDER:string[], DIM_META:object, SAMPLES:object}}
 */
export function loadEngine({ force = false } = {}) {
  const stat = fs.statSync(ENGINE_FILE);
  if (!force && cache && cache.mtimeMs === stat.mtimeMs) return cache.api;

  const html = fs.readFileSync(ENGINE_FILE, 'utf8');
  const source = extractInlineScript(html);
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  // 追加导出 shim：脚本顶层的 const 是词法绑定，不会挂到 globalThis 上，
  // 所以在源码末尾显式赋一次，之后从沙箱对象上直接取。
  const shim =
    '\n;globalThis.__EG_ENGINE__ = { analyzeEssay, EXAM_SYSTEMS, EXAM_ORDER, DIM_ORDER, DIM_META, SAMPLES };';
  vm.runInContext(source + shim, context, { filename: 'index.html#inline-script', timeout: 5000 });

  const api = context.__EG_ENGINE__;
  if (!api || typeof api.analyzeEssay !== 'function') {
    throw new Error('评分引擎导出失败：index.html 内联脚本未暴露 analyzeEssay');
  }
  cache = { mtimeMs: stat.mtimeMs, api };
  return api;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export function listExams() {
  const { EXAM_SYSTEMS, EXAM_ORDER } = loadEngine();
  return EXAM_ORDER.map(key => {
    const e = EXAM_SYSTEMS[key];
    return {
      key,
      name: e.name,
      shortName: e.shortName,
      totalMax: e.totalMax,
      totalMode: e.totalMode,
      wordTarget: e.wordTarget,
      dims: e.dims
    };
  });
}

export function isExamKey(key) {
  const { EXAM_SYSTEMS } = loadEngine();
  return Boolean(key && Object.prototype.hasOwnProperty.call(EXAM_SYSTEMS, key));
}

/**
 * 调用现有评分引擎。
 * @param {string} text 待批改文本（多模态模块传的是 normalized_text）
 * @param {string} examKey 体系 key
 */
export function gradeEssay(text, examKey) {
  if (!isExamKey(examKey)) {
    throw new AppError(ERR.INVALID_EXAM, `未知的评分体系：${examKey}`, 400, { allowed: listExamKeys() });
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new AppError(ERR.EMPTY_TEXT, '待批改文本为空', 400);
  }
  const { analyzeEssay } = loadEngine();
  return analyzeEssay(text, examKey);
}

export function listExamKeys() {
  return loadEngine().EXAM_ORDER.slice();
}

/**
 * 把引擎原始返回裁剪成稳定的对外契约。
 *
 * 为什么要裁剪：stats.words / stats.raw 这类字段是引擎内部用的，
 * 直接透出会让 API 契约跟着内部实现漂移（也会把全文再传一遍）。
 * 裁剪后「文本批改」与「多模态批改」返回的 grading 对象完全同构。
 */
export function toGradingPayload(raw) {
  const e = raw.exam;
  return {
    exam: {
      key: raw.examKey,
      name: e.name,
      shortName: e.shortName,
      totalMax: e.totalMax,
      scoreUnit: e.scoreUnit,
      totalMode: e.totalMode,
      wordTarget: e.wordTarget,
      // 档位表是"标准对齐"模块的一部分，前端做档位说明时要用
      bands: e.bands.map(b => ({ min: b.min, label: b.label, desc: b.desc }))
    },
    total: raw.total,
    totalMax: e.totalMax,
    band: { label: raw.band.label, desc: raw.band.desc, min: raw.band.min },
    dims: raw.dims.map(d => ({
      key: d.key,
      zh: d.zh,
      en: d.en,
      short: d.short,
      color: d.color,
      max: d.max,
      score: d.score,
      normalized: d.normalized,   // 0–10，雷达图用
      ratio: Number(d.ratio.toFixed(4)),
      counted: d.counted
    })),
    stats: {
      wordCount: raw.stats.wordCount,
      sentenceCount: raw.stats.sentenceCount,
      paraCount: raw.stats.paraCount,
      avgSentLen: Number(raw.stats.avgSentLen.toFixed(2)),
      sentLenStdev: Number(raw.stats.sentLenStdev.toFixed(2)),
      longRatio: Number(raw.stats.longRatio.toFixed(4)),
      ttr: Number(raw.stats.ttr.toFixed(4)),
      advRatio: Number(raw.stats.advRatio.toFixed(4))
    },
    metrics: {
      spellErr: raw.metrics.spellErr,
      lexErr: raw.metrics.lexErr ?? 0,
      transCount: raw.metrics.transCount ?? 0,
      exampleCount: raw.metrics.exampleCount ?? 0,
      complexCount: raw.metrics.complexCount ?? 0,
      hasThesis: Boolean(raw.metrics.hasThesis),
      hasConclusion: Boolean(raw.metrics.hasConclusion),
      mechErr: raw.metrics.mechErr ?? 0,
      clicheHits: (raw.metrics.clicheHits || []).slice(0, 6),
      vagueHits: (raw.metrics.vagueHits || []).slice(0, 8),
      repeated: (raw.metrics.repeated || []).slice(0, 5).map(r => ({ word: r.word, count: r.count }))
    },
    findings: (raw.findings || []).map(f => ({
      dim: f.dim,
      title: f.title,
      detail: f.detail,
      examples: f.examples || [],
      severity: f.severity,
      count: f.count
    })),
    comment: {
      strengths: raw.comment.strengths,
      problems: raw.comment.problems,
      advice: raw.comment.advice,
      verdict: raw.comment.verdict
    }
  };
}

/** 便捷方法：直接拿到对外契约 */
export function grade(text, examKey) {
  return toGradingPayload(gradeEssay(text, examKey));
}
