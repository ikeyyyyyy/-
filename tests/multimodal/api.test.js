/**
 * 多模态 - 集成测试（HTTP 层）。
 * 覆盖验收标准：上传图片能得到标准化文本并触发现有评分；低置信度有 needs_review；
 * 原有文本批改端点不受影响；错误输入有明确错误码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withServer, imageForm, REPO_ROOT } from '../helpers/server.js';

const FIXTURE_DIR = path.join(REPO_ROOT, 'sample_data/ocr_fixtures');
const printedText = () => fs.readFileSync(path.join(FIXTURE_DIR, 'printed_sample.txt'), 'utf8').trim();

test('印刷体样例：上传 -> 标准化文本 -> 复用现有评分', async () => {
  await withServer(async ({ post, upload, get }) => {
    const { form } = await imageForm('printed_sample.png', { exam_key: 'cet4', student_id: 'anon_test_01' });
    const res = await upload('/api/multimodal/upload', form);

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const sub = res.body.submission;
    assert.equal(sub.source_type, 'image');
    assert.equal(sub.student_id, 'anon_test_01');
    assert.equal(sub.needs_review, false, '印刷体样例置信度 0.96，不应标记复核');

    // 标准化文本 == 夹具文本（说明预处理没有篡改内容）
    assert.equal(sub.normalized_text, printedText());

    // 评分结果与文本批改同构
    const g = sub.grading;
    assert.ok(g.total > 0 && g.total <= g.totalMax);
    assert.equal(g.dims.length, 5);
    assert.equal(typeof g.band.label, 'string');
    assert.ok(g.comment.strengths.length > 0 && g.comment.advice.length > 0);
    assert.equal(g.exam.key, 'cet4');

    // 预处理报告字段齐全
    const r = sub.preprocess_report;
    assert.equal(typeof r.confidence, 'number');
    assert.equal(r.needs_review, false);
    assert.ok(Array.isArray(r.corrections) && Array.isArray(r.warnings) && Array.isArray(r.steps));
    assert.equal(r.stats.paragraphs, 4);

    // 详情接口能取回同一条提交
    const detail = await get(`/api/multimodal/submissions/${sub.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.submission.sha256, sub.sha256);
  });
});

test('原图 URL 可以直接下载且是 image/png', async () => {
  await withServer(async ({ upload, raw }) => {
    const { form } = await imageForm('printed_sample.png', { exam_key: 'cet4' });
    const res = await upload('/api/multimodal/upload', form);
    const url = res.body.submission.original_url;
    assert.match(url, /^\/uploads\/sub_[0-9a-f]+\.png$/);

    const imgRes = await raw(url);
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await imgRes.arrayBuffer());
    assert.ok(buf.length > 10000, '图片应有实际大小');
  });
});

test('手写样例：低置信度 -> needs_review，但仍然完成评分', async () => {
  await withServer(async ({ upload }) => {
    const { form } = await imageForm('handwriting_sample.png', { exam_key: 'cet4' });
    const res = await upload('/api/multimodal/upload', form);

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const sub = res.body.submission;
    assert.equal(sub.needs_review, true, '置信度 0.62 应触发人工复核');
    assert.ok(sub.review_reasons.some(x => x.includes('置信度')));
    assert.ok(sub.preprocess_report.warnings.some(w => w.includes('mock')));
    // 关键：低置信度不阻断评分
    assert.ok(sub.grading && typeof sub.grading.total === 'number');
    assert.ok(sub.analysis.error_categories.length >= 0);
  });
});

test('识别结果编辑确认：用校对后的文本重新评分，且保留 OCR 原文', async () => {
  await withServer(async ({ upload, post, get }) => {
    const { form } = await imageForm('handwriting_sample.png', { exam_key: 'cet4' });
    const up = await upload('/api/multimodal/upload', form);
    const sub = up.body.submission;

    const edited =
      'I think a part-time job is good for students, because we can get money and experience from it. ' +
      'However, some students spend too much time on it, so they forget their study. ' +
      'In my opinion, we should choose a job near the school and work only at the weekend.';

    const res = await post(`/api/multimodal/submissions/${sub.id}/confirm`, {
      normalized_text: edited,
      exam_key: 'cet4'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = res.body.submission;

    assert.equal(after.confirmed, true);
    assert.equal(after.edited, true);
    assert.equal(after.normalized_text, edited);
    assert.equal(after.ocr_text, sub.ocr_text, 'OCR 原文必须保留，便于追溯');
    assert.equal(after.preprocess_report.needs_review, false, '人工确认后应清除复核标记');
    assert.equal(after.grading.stats.wordCount > sub.grading.stats.wordCount, true, '校对后字数应增加');

    const check = await get(`/api/multimodal/submissions/${sub.id}`);
    assert.equal(check.body.submission.normalized_text, edited);
  });
});

test('未知图片：422 且不留下孤儿文件', async () => {
  await withServer(async ({ upload, tmp }) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('hello not an essay')], { type: 'image/png' }), 'random.png');
    form.append('exam_key', 'cet4');
    const res = await upload('/api/multimodal/upload', form);

    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'TEXT_TOO_SHORT');
    assert.ok(res.body.error.details.ocr_engine === 'mock');

    const files = fs.readdirSync(path.join(tmp, 'uploads')).filter(f => f !== '.gitkeep');
    assert.deepEqual(files, [], '失败的上传应清理原图');
  });
});

test('参数校验：非法 MIME 415、非法体系 400、缺文件 400', async () => {
  await withServer(async ({ upload, post, raw }) => {
    const bad = new FormData();
    bad.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'text/plain' }), 'a.txt');
    bad.append('exam_key', 'cet4');
    const r1 = await upload('/api/multimodal/upload', bad);
    assert.equal(r1.status, 415);
    assert.equal(r1.body.error.code, 'UNSUPPORTED_MEDIA');

    const { form } = await imageForm('printed_sample.png', { exam_key: 'not_an_exam' });
    const r2 = await upload('/api/multimodal/upload', form);
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error.code, 'INVALID_EXAM');
    assert.ok(Array.isArray(r2.body.error.details.allowed));

    const empty = new FormData();
    empty.append('exam_key', 'cet4');
    const r3 = await upload('/api/multimodal/upload', empty);
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error.code, 'NO_FILE');

    const r4 = await raw('/api/multimodal/submissions/sub_doesnotexist');
    assert.equal(r4.status, 404);
    assert.equal((await r4.json()).error.code, 'SUBMISSION_NOT_FOUND');
  });
});

test('JSON base64 上传通道可用（便于脚本/curl 调用）', async () => {
  await withServer(async ({ post }) => {
    const buf = fs.readFileSync(path.join(REPO_ROOT, 'sample_data/images/printed_sample.png'));
    const res = await post('/api/multimodal/upload', {
      filename: 'printed_sample.png',
      mime: 'image/png',
      data_base64: buf.toString('base64'),
      exam_key: 'gaokao'
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.submission.grading.exam.key, 'gaokao');
    assert.equal(res.body.submission.grading.totalMax, 25);
  });
});

test('原有前端页面与文本批改路径不受影响', async () => {
  await withServer(async ({ raw, post, get }) => {
    // 1) 老页面仍可访问且内容完整
    const page = await raw('/index.html');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('English Essay Grader'));
    assert.ok(html.includes('analyzeEssay'), '老页面内联脚本仍在');
    assert.ok(html.includes('免责声明') || html.includes('AI 参考分'));

    // 2) 文本批改（analytics 的入库通道）在新增多模态模块后照常工作
    const rec = await post('/api/analytics/records', {
      text: 'Online learning is convenient. However, it requires strong self-discipline. For example, students who plan their week carefully can finish more work than those who do not.',
      exam_key: 'cet4',
      student_id: 'anon_text_only'
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.ok(rec.body.total > 0);

    // 3) 老接口没有 /api/multimodal 之外的副作用：健康检查列出全部模块
    const health = await get('/api/health');
    assert.deepEqual(health.body.modules.slice(0, 4), ['grading', 'visualization', 'comment', 'standard-alignment']);
  });
});

test('GET /api/multimodal/engines 暴露引擎状态与阈值', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/api/multimodal/engines');
    assert.equal(res.status, 200);
    assert.equal(res.body.engines.length, 4);
    assert.equal(typeof res.body.confidence_threshold, 'number');
    assert.ok(res.body.engines.some(e => e.active));
  });
});
