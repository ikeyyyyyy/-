/**
 * 学习分析 - 集成测试。
 * 用 sample_data/essays.json 走真实链路（入库 -> 聚合 -> 出接口），
 * 覆盖验收标准：多次提交能出趋势、能识别顽固错误 Top3、旧数据/无 student_id 不崩。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withServer, REPO_ROOT } from '../helpers/server.js';

const dataset = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'sample_data/essays.json'), 'utf8'));
const STUDENT = 'anon_itest_01';

/** 按 day_offset 逐篇写入，模拟"一个学生在一学期里的 5 次提交" */
async function seedVia(ctx, studentId = STUDENT) {
  const ids = [];
  const now = Date.now();
  for (const item of dataset.submissions) {
    const at = new Date(now + item.day_offset * 86400000).toISOString();
    const res = await ctx.post('/api/analytics/records', {
      text: item.text,
      exam_key: item.exam_key,
      student_id: studentId,
      created_at: at,
      meta: { demo_label: item.label }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.push(res.body.submission_id);
  }
  return ids;
}

test('5 次提交后：仪表盘有完整趋势数据', async () => {
  await withServer(async ctx => {
    await seedVia(ctx);
    const res = await ctx.get(`/api/analytics/students/${STUDENT}/dashboard`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body;

    assert.equal(d.empty, false);
    assert.equal(d.submission_count, 5);
    assert.equal(d.score.points.length, 5);
    assert.equal(d.score.trend, 'up', '五篇质量递进，趋势应为上升');
    assert.ok(d.score.delta > 0);
    // 每条都带档位与体系，前端可直接做 tooltip
    assert.ok(d.score.points.every(p => p.exam_key === 'cet4' && typeof p.band_label === 'string'));

    // 五个维度都有序列
    assert.deepEqual(d.dimensions.keys, ['content', 'structure', 'lexis', 'grammar', 'mechanics']);
    for (const k of d.dimensions.keys) {
      assert.equal(d.dimensions.series[k].points.length, 5, `${k} 应有 5 个点`);
      assert.equal(typeof d.dimensions.averages[k], 'number');
    }

    // 错误类型趋势：堆叠图要的数据
    assert.ok(d.error_categories.points.length === 5);
    assert.ok(d.error_categories.totals.length >= 3);
    assert.ok(d.error_categories.totals[0].submissions >= 2, '第一名应是重复出现的错误');

    // 词汇多样性 + 结构完整度
    assert.equal(d.lexical_diversity.points.length, 5);
    assert.ok(d.lexical_diversity.average_ttr > 0);
    assert.equal(d.structure.points.length, 5);
    assert.equal(typeof d.structure.averages.transitions, 'number');
  });
});

test('档案接口：顽固错误 Top 3 + 优势项 + 升档建议', async () => {
  await withServer(async ctx => {
    await seedVia(ctx);
    const res = await ctx.get(`/api/analytics/students/${STUDENT}/profile`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = res.body;

    assert.equal(p.empty, false);
    assert.equal(p.sample_size, 5);
    assert.ok(p.stubborn_errors.length >= 2 && p.stubborn_errors.length <= 3);
    for (const s of p.stubborn_errors) {
      assert.ok(s.submissions >= 2, '顽固错误必须至少出现 2 次');
      assert.ok(['up', 'down', 'flat'].includes(s.trend));
      assert.equal(typeof s.label, 'string');
    }
    // 排序：出现篇数从多到少
    const counts = p.stubborn_errors.map(s => s.submissions);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));

    assert.ok(p.strengths.length >= 1);
    assert.ok(p.focus && p.focus.key);
    assert.ok(p.band_up_advice.length >= 1);
    assert.ok(typeof p.summary === 'string' && p.summary.length > 10);
  });
});

test('跨篇提示可进入评语模块：指定 current 时给出对应口径', async () => {
  await withServer(async ctx => {
    const ids = await seedVia(ctx);
    // 取第 1 篇（错误最多）作为"当前正在看的那篇"
    const res = await ctx.get(`/api/analytics/students/${STUDENT}/profile?current=${ids[0]}`);
    assert.equal(res.status, 200);
    const hint = res.body.hint;
    assert.equal(hint.available, true);
    assert.equal(hint.mode, 'recur');
    assert.equal(hint.dismissible, true, '前端提示必须可关闭');
    assert.ok(hint.text.includes('你上次'), hint.text);
    assert.ok(typeof hint.category === 'string');

    // 最后一篇（最干净）应退化为 watch 口径
    const res2 = await ctx.get(`/api/analytics/students/${STUDENT}/profile?current=${ids[4]}`);
    assert.ok(['recur', 'watch'].includes(res2.body.hint.mode));
  });
});

test('时间线：按时间倒序，字段够前端渲染列表', async () => {
  await withServer(async ctx => {
    await seedVia(ctx);
    const res = await ctx.get(`/api/analytics/students/${STUDENT}/timeline`);
    assert.equal(res.status, 200);
    const t = res.body;
    assert.equal(t.count, 5);
    assert.equal(t.empty, false);
    const times = t.items.map(i => new Date(i.at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a), '应为倒序');
    assert.ok(t.items.every(i => i.total !== null && i.submission_id));
  });
});

test('未知学生 / 无历史：返回 200 + 暂无历史数据，不报错', async () => {
  await withServer(async ctx => {
    for (const ep of ['dashboard', 'profile', 'timeline']) {
      const res = await ctx.get(`/api/analytics/students/anon_nobody/${ep}`);
      assert.equal(res.status, 200, `${ep} 不应报错`);
      assert.equal(res.body.empty, true);
      assert.equal(res.body.message, '暂无历史数据');
      assert.equal(res.body.student_known, false);
    }
  });
});

test('无 student_id 的提交可以入库，且不影响任何学生的聚合', async () => {
  await withServer(async ctx => {
    const anon = await ctx.post('/api/analytics/records', {
      text: 'Some students prefer to study alone, while others learn better in groups. Both ways have advantages.',
      exam_key: 'cet4'
    });
    assert.equal(anon.status, 201, JSON.stringify(anon.body));
    assert.equal(anon.body.student_id, null);
    assert.equal(anon.body.hint, null);

    const list = await ctx.get('/api/analytics/students');
    assert.equal(list.body.students.length, 0, '无 student_id 的记录不应凭空造出一个学生');

    const dash = await ctx.get('/api/analytics/students/anon_nobody/dashboard');
    assert.equal(dash.body.empty, true);
  });
});

test('非法 student_id 被拒绝（防 PII 混入）', async () => {
  await withServer(async ctx => {
    const res = await ctx.get('/api/analytics/students/a@b.com/dashboard');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_REQUEST');

    const post = await ctx.post('/api/analytics/records', {
      text: 'A short essay about campus life and its meaning.',
      exam_key: 'cet4',
      student_id: '张三同学'
    });
    assert.equal(post.status, 400);
  });
});

test('隐私删除：清空该学生全部记录与原图', async () => {
  await withServer(async ctx => {
    const ids = await seedVia(ctx);
    const del = await ctx.del(`/api/analytics/students/${STUDENT}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.removed_submissions, 5);

    const dash = await ctx.get(`/api/analytics/students/${STUDENT}/dashboard`);
    assert.equal(dash.body.empty, true);
    assert.equal(dash.body.submission_count, 0);

    // 记录已删，单条详情也应 404
    const one = await ctx.get(`/api/multimodal/submissions/${ids[0]}`);
    assert.equal(one.status, 404);
  });
});

test('学生列表接口按最近提交排序', async () => {
  await withServer(async ctx => {
    await seedVia(ctx, 'anon_itest_02');
    const list = await ctx.get('/api/analytics/students');
    assert.equal(list.status, 200);
    assert.equal(list.body.students.length, 1);
    assert.equal(list.body.students[0].student_id, 'anon_itest_02');
    assert.equal(list.body.students[0].submissions, 5);
    assert.ok(list.body.students[0].last_submission_at);
  });
});

test('幂等入库：同一学生重复提交相同文本不会产生重复记录', async () => {
  await withServer(async ctx => {
    const body = {
      text: dataset.submissions[2].text,
      exam_key: 'cet4',
      student_id: 'anon_idem_01'
    };
    const first = await ctx.post('/api/analytics/records', body);
    const second = await ctx.post('/api/analytics/records', body);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.deduplicated, false);
    assert.equal(second.body.deduplicated, true, '第二次应命中已有记录');
    assert.equal(second.body.submission_id, first.body.submission_id);

    const dash = await ctx.get('/api/analytics/students/anon_idem_01/dashboard');
    assert.equal(dash.body.submission_count, 1, '趋势数据不应被重复提交污染');
  });
});

test('空文本入库返回 400，非法体系返回 400', async () => {
  await withServer(async ctx => {
    const empty = await ctx.post('/api/analytics/records', { text: '   ', exam_key: 'cet4' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'EMPTY_TEXT');

    const badExam = await ctx.post('/api/analytics/records', {
      text: 'This is a short essay used to test exam validation behaviour.',
      exam_key: 'gre'
    });
    assert.equal(badExam.status, 400);
    assert.equal(badExam.body.error.code, 'INVALID_EXAM');
  });
});
