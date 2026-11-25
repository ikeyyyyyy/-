/**
 * 学习分析 - 聚合函数单元测试（纯函数，不依赖 HTTP / 磁盘）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, buildProfile, buildTimeline } from '../../backend/app/modules/analytics/aggregate.js';

const DIM_KEYS = ['content', 'structure', 'lexis', 'grammar', 'mechanics'];

/** 构造一条最小可用的批改记录 */
function mkRecord({ id, day, total, dims = {}, cats = [], ttr = 0.45, paragraphs = 3 }) {
  const normalized = dims;
  return {
    id,
    created_at: new Date(Date.UTC(2026, 0, day)).toISOString(),
    source_type: 'text',
    exam_key: 'cet4',
    exam_name: '大学英语四级 CET4 写作',
    total,
    total_max: 15,
    band_label: total >= 13 ? '优秀档（13–15 分）' : total >= 10 ? '良好档（10–12 分）' : '及格档（7–9 分）',
    grading: {
      total,
      totalMax: 15,
      band: { label: 'x', desc: 'x' },
      exam: { key: 'cet4', name: 'CET4' },
      dims: DIM_KEYS.map(k => ({ key: k, normalized: normalized[k] ?? 6, score: 2, max: 3 })),
      stats: { ttr, advRatio: 0.1, wordCount: 130, paraCount: paragraphs, sentenceCount: 10 }
    },
    analysis: {
      error_categories: cats.map(c => ({
        code: c.code,
        label: c.label,
        dim: 'grammar',
        occurrences: c.n ?? 1,
        severity: c.sev ?? 2,
        examples: c.examples || []
      })),
      lexical_diversity: { type_token_ratio: ttr, advanced_ratio: 0.1, word_count: 130 },
      structure_metrics: {
        paragraphs,
        sentences: 10,
        transitions: 4,
        complex_sentences: 2,
        avg_sentence_length: 13,
        has_thesis: true,
        has_conclusion: true,
        examples: 1
      }
    }
  };
}

const FIVE = [
  mkRecord({ id: 's1', day: 1, total: 6, dims: { content: 4, structure: 3, lexis: 3, grammar: 3, mechanics: 9 }, cats: [{ code: 'plural', label: '名词单复数', sev: 2 }, { code: 'vague_wording', label: '用词笼统', sev: 1 }], ttr: 0.38 }),
  mkRecord({ id: 's2', day: 5, total: 9, dims: { content: 6, structure: 5, lexis: 6, grammar: 5, mechanics: 9 }, cats: [{ code: 'plural', label: '名词单复数', sev: 2 }, { code: 'vague_wording', label: '用词笼统', sev: 1 }], ttr: 0.42 }),
  mkRecord({ id: 's3', day: 9, total: 11, dims: { content: 7, structure: 7, lexis: 7, grammar: 6, mechanics: 9 }, cats: [{ code: 'plural', label: '名词单复数', sev: 2 }], ttr: 0.47 }),
  mkRecord({ id: 's4', day: 13, total: 12, dims: { content: 8, structure: 7, lexis: 8, grammar: 7, mechanics: 9 }, cats: [{ code: 'vague_wording', label: '用词笼统', sev: 1 }], ttr: 0.51 }),
  mkRecord({ id: 's5', day: 17, total: 13, dims: { content: 8, structure: 8, lexis: 8, grammar: 8, mechanics: 10 }, cats: [], ttr: 0.55 })
];

test('空数据：仪表盘与档案都返回 empty 而不是抛错', () => {
  const d = buildDashboard([], { studentId: 'anon_x' });
  assert.equal(d.empty, true);
  assert.equal(d.message, '暂无历史数据');
  assert.deepEqual(d.score.points, []);

  const p = buildProfile([]);
  assert.equal(p.empty, true);
  assert.deepEqual(p.stubborn_errors, []);
  assert.equal(p.hint.available, false);
});

test('单篇提交：趋势标记为 insufficient，不硬凑趋势', () => {
  const d = buildDashboard([FIVE[0]], { studentId: 'anon_x' });
  assert.equal(d.empty, false);
  assert.equal(d.submission_count, 1);
  assert.equal(d.score.trend, 'insufficient');
  assert.equal(d.score.points.length, 1);
});

test('五篇递进：评分趋势为 up，且给出首末差值', () => {
  const d = buildDashboard(FIVE, { studentId: 'anon_x' });
  assert.equal(d.score.trend, 'up');
  assert.equal(d.score.first.total, 6);
  assert.equal(d.score.latest.total, 13);
  assert.equal(d.score.best.total, 13);
  assert.ok(d.score.delta > 0);
  assert.equal(d.error_categories.points.length, 5);
});

test('错误类型趋势：按出现篇数排序，并给出前后半段变化', () => {
  const d = buildDashboard(FIVE, { studentId: 'anon_x' });
  const top = d.error_categories.totals[0];
  assert.equal(top.code, 'plural');
  assert.equal(top.submissions, 3);
  assert.equal(top.trend, 'down', '前半段出现更多，应判定为下降趋势');
  assert.ok(top.occurrences >= 3);
});

test('维度趋势与平均值可用，缺维度时不算错', () => {
  const d = buildDashboard([...FIVE, mkRecord({ id: 'legacy', day: 20, total: 10, dims: {} })], {});
  // legacy 缺 dims 时 fallback 成 6，平均值仍然有数
  assert.equal(typeof d.dimensions.averages.content, 'number');
  assert.equal(d.dimensions.series.lexis.points.length, 6);
});

test('词汇多样性趋势可计算', () => {
  const d = buildDashboard(FIVE, {});
  assert.equal(d.lexical_diversity.points.length, 5);
  assert.equal(d.lexical_diversity.trend, 'up');
  assert.ok(d.lexical_diversity.average_ttr > 0.4);
});

test('顽固错误 Top 3：按出现篇数排序，最多 3 条', () => {
  const p = buildProfile(FIVE, { minOccurrences: 2, strengthMin: 7 });
  assert.equal(p.stubborn_errors.length, 2, '本数据集中只有 2 类错误重复出现');
  assert.equal(p.stubborn_errors[0].code, 'plural');
  assert.equal(p.stubborn_errors[0].submissions, 3);
  assert.ok(p.stubborn_errors.every(e => e.submissions >= 2));

  // 人为补足第三类，验证截断为 3
  const many = FIVE.map(r => ({
    ...r,
    analysis: {
      ...r.analysis,
      error_categories: [
        ...r.analysis.error_categories,
        { code: 'spelling', label: '拼写错误', dim: 'lexis', occurrences: 2, severity: 3, examples: [] },
        { code: 'article', label: '冠词', dim: 'grammar', occurrences: 1, severity: 2, examples: [] },
        { code: 'cohesion', label: '衔接手段', dim: 'structure', occurrences: 1, severity: 2, examples: [] }
      ]
    }
  }));
  const p2 = buildProfile(many, { minOccurrences: 2, strengthMin: 7 });
  assert.equal(p2.stubborn_errors.length, 3);
});

test('优势项与最弱维度：能定位到具体维度', () => {
  const p = buildProfile(FIVE, { minOccurrences: 2, strengthMin: 7 });
  assert.ok(p.strengths.length >= 1);
  assert.ok(p.strengths[0].average >= 7);
  assert.equal(p.focus.key, 'grammar', '语法均值最低（3,5,6,7,8 -> 5.8）');
  assert.equal(p.strengths[0].key, 'mechanics', '格式标点均值最高（9.2）');
  assert.ok(p.band_up_advice.length >= 1);
});

test('跨篇提示：本篇复现历史错误时是 recur 口径', () => {
  const p = buildProfile(FIVE, { minOccurrences: 2, currentSubmissionId: 's3' });
  assert.equal(p.hint.available, true);
  assert.equal(p.hint.mode, 'recur');
  assert.ok(p.hint.text.includes('你上次'), p.hint.text);
  assert.ok(p.hint.text.includes('名词单复数'));
  assert.equal(p.hint.dismissible, true);
});

test('跨篇提示：本篇没有复现时改为 watch 口径，不谎称"这篇也错了"', () => {
  const p = buildProfile(FIVE, { minOccurrences: 2, currentSubmissionId: 's5' });
  assert.equal(p.hint.available, true);
  assert.equal(p.hint.mode, 'watch');
  assert.ok(p.hint.text.includes('建议专门检查'));
  assert.ok(!p.hint.text.includes('你上次'));
});

test('历史不足 2 篇时提示不可用，并说明原因', () => {
  const p = buildProfile([FIVE[0]], { minOccurrences: 2 });
  assert.equal(p.hint.available, false);
  assert.equal(p.hint.mode, 'none');
  assert.ok(p.hint.reason.includes('不足'));
});

test('旧数据（无 analysis 字段）不崩溃', () => {
  const legacy = {
    id: 'legacy_1',
    created_at: '2025-01-01T00:00:00.000Z',
    source_type: 'text',
    exam_key: 'cet4',
    total: 10,
    total_max: 15,
    band_label: '良好档（10–12 分）',
    grading: { total: 10, totalMax: 15, dims: [], stats: {} }
    // 没有 analysis
  };
  const d = buildDashboard([legacy, ...FIVE], {});
  assert.equal(d.submission_count, 6);
  assert.equal(d.empty, false);
  const p = buildProfile([legacy], {});
  assert.equal(p.empty, false);
  assert.deepEqual(p.stubborn_errors, []);
  assert.equal(p.hint.available, false);
});

test('时间线按传入顺序输出，字段齐全', () => {
  const t = buildTimeline(FIVE);
  assert.equal(t.length, 5);
  assert.equal(t[0].submission_id, 's1');
  assert.equal(t[4].submission_id, 's5');
  assert.ok(t.every(x => typeof x.date === 'string' && x.percent !== null));
});
