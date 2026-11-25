/**
 * 跨篇聚合计算（纯函数，无 IO）。
 *
 * 输入永远是"按 created_at 升序的批改记录数组"，输出是前端图表直接可用的形状。
 * 这里不读库、不调评分，只做统计，方便单测覆盖边界情况（0 篇 / 1 篇 / 缺字段的旧数据）。
 */
import { adviceForCategory, adviceForDimension } from './advice.js';

const DIM_KEYS = ['content', 'structure', 'lexis', 'grammar', 'mechanics'];
const DIM_ZH = {
  content: '内容扣题与论点',
  structure: '篇章结构与连贯',
  lexis: '词汇丰富与准确',
  grammar: '语法与句式多样',
  mechanics: '格式标点规范'
};

const maxOf = arr => {
  const nums = arr.filter(v => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
};
const round = (v, p = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(p)) : null);
const avg = arr => {
  const nums = arr.filter(v => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
};
const day = iso => (iso || '').slice(0, 10);

/** 把一条记录压成聚合需要的扁平结构，缺字段一律给 null，绝不抛错（旧数据兼容） */
function flatten(sub) {
  const g = sub.grading || {};
  const dims = {};
  for (const d of g.dims || []) dims[d.key] = d.normalized;
  const cats = {};
  for (const c of sub.analysis?.error_categories || []) cats[c.code] = c.occurrences || 1;
  return {
    id: sub.id,
    at: sub.created_at,
    date: day(sub.created_at),
    exam_key: sub.exam_key || g.exam?.key || null,
    exam_name: sub.exam_name || g.exam?.name || null,
    total: typeof sub.total === 'number' ? sub.total : g.total ?? null,
    total_max: sub.total_max ?? g.totalMax ?? null,
    band_label: sub.band_label || g.band?.label || null,
    percent: (() => {
      const t = sub.total ?? g.total;
      const m = sub.total_max ?? g.totalMax;
      return typeof t === 'number' && m ? round((t / m) * 100, 1) : null;
    })(),
    dims,
    ttr: sub.analysis?.lexical_diversity?.type_token_ratio ?? g.stats?.ttr ?? null,
    adv_ratio: sub.analysis?.lexical_diversity?.advanced_ratio ?? g.stats?.advRatio ?? null,
    word_count: sub.analysis?.lexical_diversity?.word_count ?? g.stats?.wordCount ?? null,
    structure: sub.analysis?.structure_metrics || null,
    cats,
    catLabels: Object.fromEntries((sub.analysis?.error_categories || []).map(c => [c.code, c.label])),
    severity: Object.fromEntries((sub.analysis?.error_categories || []).map(c => [c.code, c.severity || 1])),
    examples: Object.fromEntries((sub.analysis?.error_categories || []).map(c => [c.code, c.examples || []])),
    source_type: sub.source_type || 'text',
    needs_review: Boolean(sub.preprocess_report?.needs_review),
    confirmed: Boolean(sub.confirmed)
  };
}

/** 首尾对比的趋势判断：percent 用 3 个百分点为阈值，比率用 0.05 */
function trendOf(points, key, flatThreshold) {
  const vals = points.map(p => p[key]).filter(v => typeof v === 'number');
  if (vals.length < 2) return { trend: 'insufficient', delta: null };
  const delta = vals[vals.length - 1] - vals[0];
  const trend = Math.abs(delta) < flatThreshold ? 'flat' : delta > 0 ? 'up' : 'down';
  return { trend, delta: round(delta, 2) };
}

export function buildTimeline(submissions) {
  return submissions.map(flatten).map(f => ({
    submission_id: f.id,
    at: f.at,
    date: f.date,
    exam_key: f.exam_key,
    exam_name: f.exam_name,
    total: f.total,
    total_max: f.total_max,
    percent: f.percent,
    band_label: f.band_label,
    source_type: f.source_type,
    needs_review: f.needs_review,
    confirmed: f.confirmed
  }));
}

/**
 * 趋势仪表盘：评分趋势 + 错误类型趋势 + 词汇多样性 + 结构完整度
 */
export function buildDashboard(submissions, { studentId = null } = {}) {
  const flat = submissions.map(flatten);

  if (!flat.length) {
    return {
      student_id: studentId,
      empty: true,
      message: '暂无历史数据',
      submission_count: 0,
      score: { points: [], best: null, latest: null, first: null, trend: 'insufficient' },
      dimensions: { keys: DIM_KEYS, series: {}, averages: {} },
      error_categories: { codes: [], points: [], totals: [] },
      lexical_diversity: { points: [], average_ttr: null, trend: 'insufficient' },
      structure: { points: [], averages: {} },
      range: null
    };
  }

  // ---- 评分趋势 ----
  const scorePoints = flat.map(f => ({
    submission_id: f.id,
    at: f.at,
    date: f.date,
    exam_key: f.exam_key,
    exam_name: f.exam_name,
    total: f.total,
    total_max: f.total_max,
    percent: f.percent,
    band_label: f.band_label
  }));
  const percents = scorePoints.map(p => p.percent).filter(v => v !== null);
  const bestPoint = scorePoints.reduce((a, b) => ((b.percent ?? -1) > (a?.percent ?? -1) ? b : a), null);

  // ---- 维度趋势 ----
  const dimSeries = {};
  const dimAverages = {};
  for (const key of DIM_KEYS) {
    const points = flat.map(f => ({ at: f.at, date: f.date, submission_id: f.id, value: f.dims[key] ?? null }));
    dimSeries[key] = {
      zh: DIM_ZH[key],
      points,
      average: round(avg(points.map(p => p.value))),
      ...trendOf(points, 'value', 0.5)
    };
    dimAverages[key] = round(avg(points.map(p => p.value)));
  }

  // ---- 错误类型趋势 ----
  const codeSet = new Set();
  for (const f of flat) for (const c of Object.keys(f.cats)) codeSet.add(c);
  const codeLabels = {};
  for (const f of flat) for (const [c, l] of Object.entries(f.catLabels)) codeLabels[c] = l;

  const errorPoints = flat.map(f => ({
    at: f.at,
    date: f.date,
    submission_id: f.id,
    counts: { ...f.cats },
    total: Object.values(f.cats).reduce((a, b) => a + b, 0)
  }));

  const totals = [...codeSet].map(code => {
    const presentIn = flat.filter(f => f.cats[code]);
    // 前后半段对比：判断这类错误在变多还是变少
    const mid = Math.ceil(flat.length / 2);
    const first = flat.slice(0, mid).filter(f => f.cats[code]).length;
    const second = flat.slice(mid).filter(f => f.cats[code]).length;
    const delta = second - first;
    return {
      code,
      label: codeLabels[code] || code,
      occurrences: presentIn.reduce((s, f) => s + f.cats[code], 0),
      submissions: presentIn.length,
      rate: round(presentIn.length / flat.length, 2),
      severity: Math.max(1, ...presentIn.map(f => f.severity[code] || 1)),
      last_seen: presentIn.length ? presentIn[presentIn.length - 1].at : null,
      trend: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      delta_submissions: delta
    };
  }).sort((a, b) => (b.submissions - a.submissions) || (b.severity - a.severity) || (b.occurrences - a.occurrences));

  // ---- 词汇多样性 ----
  const lexisPoints = flat.map(f => ({
    at: f.at,
    date: f.date,
    submission_id: f.id,
    ttr: f.ttr,
    advanced_ratio: f.adv_ratio,
    word_count: f.word_count
  }));

  // ---- 结构完整度 ----
  const structurePoints = flat.map(f => ({
    at: f.at,
    date: f.date,
    submission_id: f.id,
    paragraphs: f.structure?.paragraphs ?? null,
    sentences: f.structure?.sentences ?? null,
    transitions: f.structure?.transitions ?? null,
    complex_sentences: f.structure?.complex_sentences ?? null,
    avg_sentence_length: f.structure?.avg_sentence_length ?? null,
    dimension_normalized: f.dims.structure ?? null
  }));

  return {
    student_id: studentId,
    empty: false,
    submission_count: flat.length,
    range: { from: flat[0].at, to: flat[flat.length - 1].at },
    score: {
      points: scorePoints,
      first: scorePoints[0],
      latest: scorePoints[scorePoints.length - 1],
      best: bestPoint,
      average_percent: round(avg(percents), 1),
      ...(trendOf(scorePoints, 'percent', 3) )
    },
    dimensions: { keys: DIM_KEYS, series: dimSeries, averages: dimAverages },
    error_categories: { codes: [...codeSet], points: errorPoints, totals },
    lexical_diversity: {
      points: lexisPoints,
      average_ttr: round(avg(lexisPoints.map(p => p.ttr)), 3),
      average_advanced_ratio: round(avg(lexisPoints.map(p => p.advanced_ratio)), 3),
      ...trendOf(lexisPoints, 'ttr', 0.03)
    },
    structure: {
      points: structurePoints,
      averages: {
        paragraphs: round(avg(structurePoints.map(p => p.paragraphs))),
        transitions: round(avg(structurePoints.map(p => p.transitions))),
        complex_sentences: round(avg(structurePoints.map(p => p.complex_sentences))),
        avg_sentence_length: round(avg(structurePoints.map(p => p.avg_sentence_length)))
      },
      ...trendOf(structurePoints, 'dimension_normalized', 0.5)
    },
    exams: [...new Set(flat.map(f => f.exam_key).filter(Boolean))]
  };
}

/**
 * 个性化写作档案：顽固错误 Top 3、优势项、升档建议、跨篇提示
 * @param {Array} submissions 升序
 * @param {object} opts
 * @param {number} opts.minOccurrences 判定"顽固"所需的出现篇数
 * @param {number} opts.strengthMin 判定"优势"的归一化分下限
 * @param {string} [opts.currentSubmissionId] 用于生成"你上次也…"提示的对照篇
 */
export function buildProfile(submissions, opts = {}) {
  const minOccurrences = opts.minOccurrences ?? 2;
  const strengthMin = opts.strengthMin ?? 7;
  const flat = submissions.map(flatten);

  if (!flat.length) {
    return {
      empty: true,
      message: '暂无历史数据',
      sample_size: 0,
      stubborn_errors: [],
      strengths: [],
      focus: null,
      band_up_advice: [],
      hint: { available: false, mode: 'none', reason: '暂无历史数据，无法生成跨篇提示', dismissible: true }
    };
  }

  // ---- 顽固错误 Top 3 ----
  const catAgg = new Map();
  for (const f of flat) {
    for (const [code, count] of Object.entries(f.cats)) {
      const prev = catAgg.get(code) || {
        code,
        label: f.catLabels[code] || code,
        submissions: 0,
        occurrences: 0,
        severity: 1,
        last_seen: null,
        examples: [],
        dates: []
      };
      prev.submissions += 1;
      prev.occurrences += count;
      prev.severity = Math.max(prev.severity, f.severity[code] || 1);
      prev.last_seen = f.at;
      prev.examples.push(...(f.examples[code] || []));
      prev.dates.push(f.date);
      catAgg.set(code, prev);
    }
  }

  const mid = Math.ceil(flat.length / 2);
  const allCats = [...catAgg.values()].map(c => {
    const firstHalf = flat.slice(0, mid).filter(f => f.cats[c.code]).length;
    const secondHalf = flat.slice(mid).filter(f => f.cats[c.code]).length;
    return {
      code: c.code,
      label: c.label,
      submissions: c.submissions,
      occurrences: c.occurrences,
      rate: round(c.submissions / flat.length, 2),
      severity: c.severity,
      last_seen: c.last_seen,
      trend: secondHalf > firstHalf ? 'up' : secondHalf < firstHalf ? 'down' : 'flat',
      examples: [...new Set(c.examples)].slice(0, 2),
      dates: c.dates
    };
  });

  const stubborn = allCats
    .filter(c => c.submissions >= Math.min(minOccurrences, flat.length) && c.submissions >= 2)
    .sort((a, b) => (b.submissions - a.submissions) || (b.severity - a.severity) || (b.occurrences - a.occurrences))
    .slice(0, 3);

  // ---- 优势项 ----
  const dimAvg = DIM_KEYS.map(key => ({
    key,
    zh: DIM_ZH[key],
    average: round(avg(flat.map(f => f.dims[key])), 1),
    best: round(maxOf(flat.map(f => f.dims[key])), 1)
  })).filter(d => d.average !== null).sort((a, b) => b.average - a.average);

  let strengths = dimAvg.filter(d => d.average >= strengthMin);
  if (!strengths.length && dimAvg.length) strengths = [dimAvg[0]];   // 都不达标时也给出"相对最好"
  const focus = dimAvg.length ? [...dimAvg].sort((a, b) => a.average - b.average)[0] : null;

  // ---- 升档建议 ----
  const adviceList = [];
  for (const s of stubborn.slice(0, 2)) {
    const text = adviceForCategory(s.code);
    if (text) adviceList.push({ text, based_on: `顽固错误「${s.label}」：${s.submissions}/${flat.length} 篇出现`, category: s.code });
  }
  if (focus && adviceList.length < 3) {
    const text = adviceForDimension(focus.key);
    if (text) adviceList.push({ text, based_on: `最弱维度「${focus.zh}」均值 ${focus.average}/10`, category: focus.key });
  }

  // ---- 跨篇提示（供现有评语模块展示，可关闭） ----
  const current = opts.currentSubmissionId
    ? flat.find(f => f.id === opts.currentSubmissionId) || flat[flat.length - 1]
    : flat[flat.length - 1];
  const hits = stubborn.filter(s => current.cats[s.code]);
  let hint;
  if (hits.length) {
    // 本篇确实重复了历史错误：可以直接说"上次也犯了"
    hint = {
      available: true,
      mode: 'recur',
      dismissible: true,
      text: `你上次（${day(hits[0].last_seen)}）也犯了类似的「${hits[0].label}」问题，近 ${flat.length} 篇里出现了 ${hits[0].submissions} 次。`,
      category: hits[0].code,
      category_label: hits[0].label,
      occurrences: hits[0].submissions,
      sample_size: flat.length,
      examples: hits[0].examples
    };
  } else if (stubborn.length) {
    // 本篇没有复现，但历史上有顽固错误：改成提醒口吻，不谎称"这篇也错了"
    hint = {
      available: true,
      mode: 'watch',
      dismissible: true,
      text: `近 ${flat.length} 篇里「${stubborn[0].label}」出现了 ${stubborn[0].submissions} 次，交卷前建议专门检查一遍。`,
      category: stubborn[0].code,
      category_label: stubborn[0].label,
      occurrences: stubborn[0].submissions,
      sample_size: flat.length,
      examples: stubborn[0].examples
    };
  } else {
    hint = {
      available: false,
      mode: 'none',
      dismissible: true,
      reason: flat.length < 2 ? '历史提交不足 2 篇' : '暂未发现重复出现的错误类型',
      sample_size: flat.length
    };
  }

  return {
    empty: false,
    sample_size: flat.length,
    range: { from: flat[0].at, to: flat[flat.length - 1].at },
    stubborn_errors: stubborn,
    strengths,
    focus,
    band_up_advice: adviceList.slice(0, 3),
    hint,
    // 供页面顶部展示的"一句话画像"
    summary: buildSummary({ flat, stubborn, strengths, focus })
  };
}

function buildSummary({ flat, stubborn, strengths, focus }) {
  const latest = flat[flat.length - 1];
  const parts = [`已积累 ${flat.length} 篇批改记录`];
  if (latest?.band_label) parts.push(`最近一篇落在「${latest.band_label.split('（')[0]}」`);
  if (stubborn.length) parts.push(`最顽固的问题是${stubborn[0].label}（${stubborn[0].submissions} 篇出现）`);
  else parts.push('暂未发现重复出现的错误类型');
  if (strengths.length) parts.push(`相对优势是${strengths[0].zh}`);
  else if (focus) parts.push(`最需要补的是${focus.zh}`);
  return parts.join('，') + '。';
}
