/**
 * 学习分析模块路由：全部挂在 /api/analytics/* 下。
 *
 *   POST   /api/analytics/records                            记录入库（文本提交，调用现有评分适配器）
 *   GET    /api/analytics/students                           学生列表（演示页下拉用）
 *   GET    /api/analytics/students/:id/dashboard             趋势仪表盘数据
 *   GET    /api/analytics/students/:id/profile               个性化档案（顽固错误 Top3 + 优势 + 建议 + 跨篇提示）
 *   GET    /api/analytics/students/:id/timeline              按时间倒序的提交列表
 *   DELETE /api/analytics/students/:id                       隐私删除（连同上传原图一并清除）
 */
import { ok, readJsonBody } from '../../http/respond.js';
import { listStudents } from '../../store/db.js';
import { getDashboard, getProfile, getTimeline, ingestRecord, removeStudent } from './service.js';
import { removeAssets } from '../multimodal/storage.js';

export function registerAnalyticsRoutes(router) {
  router.post('/api/analytics/records', async (req, res) => {
    const body = await readJsonBody(req, 4 * 1024 * 1024);
    const result = await ingestRecord({
      text: body.text,
      examKey: body.exam_key || body.examKey || 'cet4',
      studentId: body.student_id ?? body.studentId ?? null,
      createdAt: body.created_at || null,
      meta: body.meta
    });
    ok(res, result, 201);
  });

  router.get('/api/analytics/students', (req, res) => {
    ok(res, {
      students: listStudents().map(s => ({
        student_id: s.id,
        submissions: s.submissions || 0,
        exam_keys: s.exam_keys || {},
        first_seen: s.created_at,
        last_submission_at: s.last_submission_at || null
      }))
    });
  });

  router.get('/api/analytics/students/:id/dashboard', (req, res, ctx) => {
    ok(res, getDashboard(ctx.params.id));
  });

  router.get('/api/analytics/students/:id/profile', (req, res, ctx) => {
    const current = ctx.url?.searchParams?.get('current') || null;
    ok(res, getProfile(ctx.params.id, { currentSubmissionId: current }));
  });

  router.get('/api/analytics/students/:id/timeline', (req, res, ctx) => {
    ok(res, getTimeline(ctx.params.id));
  });

  router.delete('/api/analytics/students/:id', async (req, res, ctx) => {
    const result = await removeStudent(ctx.params.id);
    // 记录删掉后，把对应的原图也从磁盘清掉，避免"删了记录但图片还在"
    const assetResult = await removeAssets(result.removed_assets.map(p => ({ file: p })));
    ok(res, {
      student_id: ctx.params.id,
      removed_submissions: result.removed_submissions,
      removed_assets: assetResult.filter(a => a.removed).length
    });
  });
}
