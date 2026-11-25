/**
 * 批改记录适配器：把评分服务返回的 findings 映射成结构化分析字段。
 *
 * 为什么放在 adapters 而不是 analytics 模块里：
 * 写入（多模态 / 文本）和读取（学习分析）都需要同一份分类标准，
 * 放在共享适配层可以保证「写进去的标签」和「读出来的趋势」口径一致。
 *
 * 注意：本文件只做归类和统计，不参与任何打分决策——评分仍然只由 index.html 里的引擎产出。
 */

/**
 * 29 条诊断规则 -> 规范化错误类别。
 * match 用正则匹配引擎给出的中文标题；命中第一条即止。
 * 引擎将来新增规则时，未命中的会落到 fallback（按维度给一个通用类别），不会丢数据。
 */
export const CATEGORY_RULES = [
  { code: 'spelling', label: '拼写错误', dim: 'lexis', match: /拼写/ },
  { code: 'capitalization', label: '大小写规范', dim: 'mechanics', match: /大写/ },
  { code: 'punctuation', label: '标点规范', dim: 'mechanics', match: /标点|句号|空格/ },
  { code: 'agreement', label: '主谓一致', dim: 'grammar', match: /主谓/ },
  { code: 'article', label: '冠词', dim: 'grammar', match: /冠词/ },
  { code: 'plural', label: '名词单复数', dim: 'grammar', match: /复数/ },
  { code: 'verb_form', label: '动词形式', dim: 'grammar', match: /动词形式|时态/ },
  { code: 'word_class', label: '词性误用', dim: 'grammar', match: /词性/ },
  { code: 'chinglish', label: '中式表达', dim: 'grammar', match: /中式/ },
  { code: 'fragment', label: '句子片段', dim: 'grammar', match: /从句独立|片段/ },
  { code: 'run_on', label: '超长句', dim: 'grammar', match: /过长|run-on/ },
  { code: 'comma_splice', label: '逗号拼接', dim: 'grammar', match: /逗号拼接/ },
  { code: 'sentence_variety', label: '句式单一', dim: 'grammar', match: /句式偏单一/ },
  { code: 'complex_structure', label: '缺少复杂句', dim: 'grammar', match: /复杂句式/ },
  { code: 'vague_wording', label: '用词笼统', dim: 'lexis', match: /笼统/ },
  { code: 'cliche', label: '模板化表达', dim: 'lexis', match: /模板/ },
  { code: 'repetition', label: '词汇重复', dim: 'lexis', match: /重复/ },
  { code: 'paragraphing', label: '段落划分', dim: 'structure', match: /段落|只有一段/ },
  { code: 'cohesion', label: '衔接手段', dim: 'structure', match: /衔接/ },
  { code: 'thesis', label: '论点明确度', dim: 'content', match: /立场句/ },
  { code: 'conclusion', label: '收尾总结', dim: 'content', match: /收尾|总结/ },
  { code: 'evidence', label: '例证支撑', dim: 'content', match: /例证/ }
];

const FALLBACK_LABEL = {
  content: { code: 'content_other', label: '内容其它问题' },
  structure: { code: 'structure_other', label: '结构其它问题' },
  lexis: { code: 'lexis_other', label: '词汇其它问题' },
  grammar: { code: 'grammar_other', label: '语法其它问题' },
  mechanics: { code: 'mechanics_other', label: '规范其它问题' }
};

export function categorizeFinding(finding) {
  const hit = CATEGORY_RULES.find(r => r.match.test(finding.title || ''));
  if (hit) return { code: hit.code, label: hit.label, dim: hit.dim };
  const fb = FALLBACK_LABEL[finding.dim] || { code: 'other', label: '其它问题' };
  return { ...fb, dim: finding.dim };
}

/**
 * @param {object} grading scoring-adapter 输出的 grading 契约
 * @returns {{error_categories:Array, lexical_diversity:object, structure_metrics:object, evidence:Array, band_label:string}}
 */
export function buildAnalysis(grading) {
  const map = new Map();
  for (const f of grading.findings || []) {
    const cat = categorizeFinding(f);
    const prev = map.get(cat.code) || {
      code: cat.code,
      label: cat.label,
      dim: cat.dim,
      occurrences: 0,          // 命中的规则条数（同一标题只算一条，count 单独记）
      findings: 0,
      severity: 0,
      examples: []
    };
    prev.findings += 1;
    prev.occurrences += Math.max(1, f.count || 1);
    prev.severity = Math.max(prev.severity, f.severity || 1);
    prev.examples.push(...(f.examples || []));
    map.set(cat.code, prev);
  }

  const errorCategories = [...map.values()]
    .map(c => ({ ...c, examples: [...new Set(c.examples)].slice(0, 3) }))
    .sort((a, b) => (b.severity - a.severity) || (b.occurrences - a.occurrences));

  return {
    band_label: grading.band.label,
    error_categories: errorCategories,
    lexical_diversity: {
      type_token_ratio: grading.stats.ttr,
      advanced_ratio: grading.stats.advRatio,
      word_count: grading.stats.wordCount,
      top_repeated: grading.metrics.repeated
    },
    structure_metrics: {
      paragraphs: grading.stats.paraCount,
      sentences: grading.stats.sentenceCount,
      transitions: grading.metrics.transCount,
      complex_sentences: grading.metrics.complexCount,
      avg_sentence_length: grading.stats.avgSentLen,
      sentence_length_stdev: grading.stats.sentLenStdev,
      has_thesis: grading.metrics.hasThesis,
      has_conclusion: grading.metrics.hasConclusion,
      examples: grading.metrics.exampleCount
    },
    // 证据溯源：保留"哪条规则、哪段原文"，供学习分析页展示与人工复核
    evidence: (grading.findings || []).slice(0, 8).map(f => ({
      dim: f.dim,
      title: f.title,
      severity: f.severity,
      count: f.count,
      samples: (f.examples || []).slice(0, 2)
    })),
    dimension_scores: Object.fromEntries(grading.dims.map(d => [d.key, {
      score: d.score,
      max: d.max,
      normalized: d.normalized
    }]))
  };
}
