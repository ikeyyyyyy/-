/**
 * 文本级预处理（normalized_text 的产生地）。
 *
 * 职责边界（很重要）：
 *  - 图像级处理（方向矫正、去噪、二值化）由 OCR 引擎适配器负责，各引擎能力不同，
 *    本文件不做像素运算，也不假装做过——report.steps 里会如实标注引擎自报的图像处理结果。
 *  - 文本级标准化由本文件实现，与引擎无关：连字还原、断词合并、标点统一、
 *    排版噪声清理、段落还原。这些步骤都是可回放的，每一步都写进 corrections。
 *
 * 红线：不改写学生原意。所有改动只发生在「形式层」（标点、空格、断行、明显的 OCR 混淆字符），
 * 不改动实词、不替换同义词、不补全句子。
 */

/* 中文全角标点 -> 英文半角。只映射标点，不碰汉字（正常作文里也不该有汉字）。 */
const CN_PUNCT_MAP = [
  ['，', ','], ['。', '.'], ['；', ';'], ['：', ':'], ['！', '!'], ['？', '?'],
  ['（', '('], ['）', ')'], ['、', ','], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['－', '-'], ['—', '—'], ['　', ' ']
];

/* OCR 常见混淆：只做上下文严格受限的替换，宁可漏改也不误改实词 */
const OCR_CONFUSIONS = [
  // 单独一个竖线，前后是空格：几乎必然是 I
  { re: /(^|\s)\|(\s)/g, to: '$1I$2', type: 'ocr_confusion', note: '竖线 "|" 还原为 "I"', sample: '| think -> I think' },
  // 全大写词里混入数字 0：T0 -> TO
  { re: /\b([A-Z]+)0(?![0-9])/g, to: '$1O', type: 'ocr_confusion', note: '全大写词中的 0 还原为 O', sample: 'T0 -> TO' },
  // 常见连字
  { re: /\ufb01/g, to: 'fi', type: 'ligature', note: '连字 ﬁ 拆开', sample: 'ﬁrst -> first' },
  { re: /\ufb02/g, to: 'fl', type: 'ligature', note: '连字 ﬂ 拆开', sample: 'ﬂow -> flow' }
];

/**
 * @param {string} rawText OCR 原始文本
 * @param {object} [opts]
 * @param {number|null} [opts.confidence] 引擎给出的置信度（0–1，可能为 null）
 * @param {number} [opts.threshold] 人工复核阈值
 * @param {string} [opts.engine] 引擎名
 * @param {Array} [opts.engineWarnings] 引擎自报的告警
 * @param {object} [opts.imageMeta] 引擎自报的图像处理结果（rotation/denoise 等）
 */
export function preprocessText(rawText, opts = {}) {
  const threshold = opts.threshold ?? 0.75;
  const corrections = [];
  const warnings = [...(opts.engineWarnings || [])];
  const steps = [];

  const src = typeof rawText === 'string' ? rawText : '';
  if (!src.trim()) {
    return {
      engine: opts.engine || null,
      confidence: opts.confidence ?? null,
      confidence_threshold: threshold,
      needs_review: true,
      review_reasons: ['未识别到任何文本'],
      corrections: [],
      warnings: [...warnings, 'OCR 结果为空，请确认图片是否清晰、是否只包含作文正文'],
      steps: [{ name: 'text_normalize', applied: false, note: '输入为空，跳过' }],
      stats: { raw_chars: src.length, normalized_chars: 0, raw_lines: 0, paragraphs: 0, words: 0 },
      image: opts.imageMeta || null
    };
  }

  let text = src.replace(/\r\n?/g, '\n');

  /* ---- 1. 去排版噪声：孤立页码、页眉分隔线 ---- */
  const linesBefore = text.split('\n');
  const keptLines = [];
  let pageNoisy = 0;
  for (const line of linesBefore) {
    const t = line.trim();
    // 单独一行的纯数字 / 罗马数字 / "Page 3 of 5"：判为页码
    if (/^(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i.test(t) && linesBefore.length > 5) { pageNoisy++; continue; }
    if (/^[-=_~·•]{3,}$/.test(t)) { pageNoisy++; continue; }          // 页眉横线
    if (/^第\s*\d+\s*页/.test(t)) { pageNoisy++; continue; }
    keptLines.push(line);
  }
  if (pageNoisy) {
    text = keptLines.join('\n');
    corrections.push({ type: 'layout_noise', count: pageNoisy, note: '删除孤立页码/页眉横线', samples: [] });
  }
  steps.push({ name: 'denoise_lines', applied: pageNoisy > 0, note: pageNoisy ? `移除 ${pageNoisy} 行排版噪声` : '未发现页码/横线' });

  /* ---- 2. 断词还原：govern-\nment -> government ---- */
  const hyphenBreaks = text.match(/([A-Za-z]{2,})-\n\s*([a-z]{2,})/g) || [];
  if (hyphenBreaks.length) {
    text = text.replace(/([A-Za-z]{2,})-\n\s*([a-z]{2,})/g, '$1$2');
    corrections.push({
      type: 'hyphenation',
      count: hyphenBreaks.length,
      note: '合并跨行断词（连字符换行）',
      samples: hyphenBreaks.slice(0, 3).map(s => s.replace(/\n\s*/, ''))
    });
  }
  steps.push({ name: 'dehyphenate', applied: hyphenBreaks.length > 0, note: `处理 ${hyphenBreaks.length} 处跨行断词` });

  /* ---- 3. 连字与 OCR 混淆字符 ---- */
  let confusionTotal = 0;
  for (const rule of OCR_CONFUSIONS) {
    const hits = text.match(rule.re);
    if (!hits || !hits.length) continue;
    text = text.replace(rule.re, rule.to);
    confusionTotal += hits.length;
    corrections.push({ type: rule.type, count: hits.length, note: rule.note, samples: [rule.sample] });
  }
  steps.push({ name: 'fix_ocr_confusions', applied: confusionTotal > 0, note: `修正 ${confusionTotal} 处 OCR 字符混淆` });

  /* ---- 4. 引号与标点统一（全角 -> 半角，中文引号 -> 直引号） ---- */
  let punctCount = 0;
  for (const [from, to] of CN_PUNCT_MAP) {
    if (from === '—' || from === '　') {
      if (text.includes(from)) { text = text.split(from).join(to); punctCount++; }
      continue;
    }
    const parts = text.split(from);
    if (parts.length > 1) {
      punctCount += parts.length - 1;
      text = parts.join(to);
    }
  }
  // 连续三个以上的点号统一成省略号（英文习惯用 ...）
  const ellipsisHits = (text.match(/[。.]{4,}/g) || []).length;
  if (ellipsisHits) { text = text.replace(/[。.]{4,}/g, '...'); punctCount += ellipsisHits; }
  if (punctCount) {
    corrections.push({ type: 'punctuation', count: punctCount, note: '全角/中文标点统一为英文半角标点', samples: ['，-> ,', '。-> .'] });
  }
  steps.push({ name: 'normalize_punctuation', applied: punctCount > 0, note: `统一 ${punctCount} 处标点` });

  /* ---- 5. 空格规范化：标点前后空格、多空格、行尾空格 ---- */
  const before = text;
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([,.;:!?])/g, '$1')          // 标点前不留空格
    .replace(/([,;:])(?=[A-Za-z])/g, '$1 ')   // 逗号分号冒号后补空格
    .replace(/([.!?])(?=[A-Z])/g, '$1 ');     // 句末标点后补空格
  const spaceChanged = before !== text;
  if (spaceChanged) corrections.push({ type: 'spacing', count: 1, note: '收敛多余空格，补齐标点后空格', samples: [] });
  steps.push({ name: 'normalize_spacing', applied: spaceChanged, note: spaceChanged ? '已规范空格' : '空格正常' });

  /* ---- 6. 段落还原 ---- */
  const paraResult = restoreParagraphs(text);
  text = paraResult.text;
  if (paraResult.applied) {
    corrections.push({ type: 'paragraph', count: paraResult.boundaries, note: paraResult.note, samples: [] });
  }
  steps.push({ name: 'restore_paragraphs', applied: paraResult.applied, note: paraResult.note });
  if (paraResult.paragraphs === 1 && countWords(text) > 150) {
    warnings.push('只识别出 1 个段落：若原文分段，结构维度（段落/衔接）可能偏低，建议人工核对');
  }

  /* ---- 7. 收尾 ---- */
  text = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  const words = countWords(text);
  const confidence = opts.confidence ?? null;
  const reasons = [];
  if (confidence === null) reasons.push('引擎未返回置信度，需人工复核');
  else if (confidence < threshold) reasons.push(`置信度 ${confidence.toFixed(2)} 低于阈值 ${threshold}`);
  if (words < 30) reasons.push(`标准化后仅 ${words} 词，可能漏识别`);
  if (!/[.!?]/.test(text)) reasons.push('文本中没有句末标点，可能漏识别');

  const needsReview = reasons.length > 0;
  if (needsReview) warnings.push('标记为待人工复核（needs_review=true）：本次结果仍已送入评分，但建议核对原文');

  return {
    engine: opts.engine || null,
    confidence,
    confidence_threshold: threshold,
    needs_review: needsReview,
    review_reasons: reasons,
    corrections,
    warnings,
    steps,
    stats: {
      raw_chars: src.length,
      normalized_chars: text.length,
      raw_lines: linesBefore.length,
      paragraphs: paraResult.paragraphs,
      words
    },
    image: opts.imageMeta || null,
    normalized_text: text
  };
}

/**
 * 段落还原启发式（按可靠性从高到低挑选一种，并记录用了哪一种）：
 *  A. 有空行 -> 空行分段（OCR 通常保留段间距）
 *  B. 多数行有行首缩进 -> 缩进分段
 *  C. 无以上信号 -> 按「行尾是句末标点 + 下行首字母大写 + 本行词数≥8」断段（保守，宁可少断）
 *  D. 都不满足 -> 单段
 */
export function restoreParagraphs(input) {
  const text = input.replace(/\t/g, '    ');
  const rawLines = text.split('\n');
  const lines = rawLines.map(l => l.replace(/\s+$/, '')).filter((l, i, arr) => !(l.trim() === '' && arr[i - 1]?.trim() === ''));

  const blankLineBlocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const hasBlankLineSignal = blankLineBlocks.length >= 2;

  const indentedCount = lines.filter(l => /^\s{2,}\S/.test(l)).length;
  const nonEmpty = lines.filter(l => l.trim());
  const hasIndentSignal = !hasBlankLineSignal && nonEmpty.length >= 2 && indentedCount / nonEmpty.length >= 0.5;

  let blocks;
  let note;
  if (hasBlankLineSignal) {
    blocks = blankLineBlocks.map(b => joinLines(b.split('\n')));
    note = '按空行还原段落';
  } else if (hasIndentSignal) {
    blocks = [];
    let cur = [];
    for (const line of lines) {
      if (/^\s{2,}\S/.test(line) && cur.length) { blocks.push(joinLines(cur)); cur = [line]; }
      else cur.push(line);
    }
    if (cur.length) blocks.push(joinLines(cur));
    note = '按行首缩进还原段落';
  } else {
    // 保守断段：只有明确的"句子结束 + 新句开始"才断
    blocks = [];
    let cur = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      cur.push(line);
      const trimmed = line.trim();
      const next = (lines[i + 1] || '').trim();
      const endsSentence = /[.!?]["')\]]?$/.test(trimmed);
      const nextStartsUpper = /^["'(\[]?[A-Z]/.test(next);
      const longEnough = trimmed.split(/\s+/).filter(Boolean).length >= 8;
      if (line.trim() === '' || (endsSentence && nextStartsUpper && longEnough && next)) {
        blocks.push(joinLines(cur));
        cur = [];
      }
    }
    if (cur.length) blocks.push(joinLines(cur));
    note = '按句末标点 + 大写开头推断段落（保守策略）';
  }

  blocks = blocks.map(b => b.trim()).filter(Boolean);
  const joined = blocks.join('\n\n');
  const changed = joined !== input.trim();
  return {
    text: joined,
    paragraphs: Math.max(1, blocks.length),
    boundaries: Math.max(0, blocks.length - 1),
    applied: changed && blocks.length >= 1,
    note
  };
}

/** 段内换行合并成空格；已存在句末标点的行之间补一个空格，避免粘连 */
function joinLines(lines) {
  return lines
    .map(l => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ');
}

export function countWords(text) {
  return (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
}
