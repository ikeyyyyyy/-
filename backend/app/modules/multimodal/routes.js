/**
 * 多模态模块路由：全部挂在 /api/multimodal/* 下，不触碰任何既有端点。
 *
 * 端点：
 *   GET  /api/multimodal/engines                      引擎状态（前端据此提示"当前是否真实识别"）
 *   POST /api/multimodal/upload                       上传图片/PDF -> OCR -> 预处理 -> 评分
 *   GET  /api/multimodal/submissions/:id              取原图 URL / OCR 原文 / 标准化文本 / 预处理报告 / 评分结果
 *   POST /api/multimodal/submissions/:id/confirm      识别结果人工校对后重新评分
 */
import { config } from '../../config.js';
import { AppError, ERR } from '../../errors.js';
import { readBody, readJsonBody, ok } from '../../http/respond.js';
import { getBoundary, parseMultipart, normalizeParts } from '../../http/multipart.js';
import { describeEngines } from './ocr/index.js';
import { listExams } from '../../adapters/scoring-adapter.js';
import { createSubmissionFromUpload, confirmSubmission, getSubmissionPayload } from './service.js';

export function registerMultimodalRoutes(router) {
  router.get('/api/multimodal/engines', (req, res) => {
    ok(res, {
      active: config.ocr.engine,
      confidence_threshold: config.ocr.confidenceThreshold,
      engines: describeEngines()
    });
  });

  // 上传页的「评分体系」下拉数据：直接读现有引擎的体系配置，前端不重复维护一份
  router.get('/api/multimodal/exams', (req, res) => {
    ok(res, { exams: listExams() });
  });

  router.post('/api/multimodal/upload', async (req, res) => {
    const { buffer, filename, mime, fields } = await readUpload(req);
    const result = await createSubmissionFromUpload({
      buffer,
      filename,
      mime,
      examKey: fields.exam_key || 'cet4',
      studentId: fields.student_id || null,
      engineName: fields.ocr_engine || undefined
    });
    ok(res, result, 201);
  });

  router.get('/api/multimodal/submissions/:id', (req, res, ctx) => {
    ok(res, { submission: getSubmissionPayload(ctx.params.id) });
  });

  router.post('/api/multimodal/submissions/:id/confirm', async (req, res, ctx) => {
    const body = await readJsonBody(req, 1024 * 1024);
    const result = await confirmSubmission(ctx.params.id, {
      normalizedText: body.normalized_text ?? body.text,
      examKey: body.exam_key
    });
    ok(res, result);
  });
}

/**
 * 兼容两种上传方式：
 *  1) multipart/form-data（浏览器 FormData，推荐；只有这种能拿到真实二进制）
 *  2) application/json + data_base64（便于 curl / 自动化脚本调用）
 */
async function readUpload(req) {
  const ct = String(req.headers['content-type'] || '');

  if (ct.includes('multipart/form-data')) {
    const boundary = getBoundary(ct);
    if (!boundary) throw new AppError(ERR.INVALID_REQUEST, 'multipart 请求缺少 boundary', 400);
    // 留 1MB 余量给表单字段与 multipart 头部
    const raw = await readBody(req, config.maxUploadBytes + 1024 * 1024);
    const { fields, files } = normalizeParts(parseMultipart(raw, boundary));
    const file = files.file || files.image || files.essay || Object.values(files)[0];
    if (!file) throw new AppError(ERR.NO_FILE, '表单中没有找到文件字段（file / image）', 400);
    return {
      buffer: file.data,
      filename: file.filename,
      // 有些客户端不给 content-type，此时按扩展名兜底推断
      mime: file.contentType || guessMime(file.filename),
      fields
    };
  }

  const body = await readJsonBody(req, Math.ceil(config.maxUploadBytes * 1.4));
  const base64 = body.data_base64 || body.data || body.base64;
  if (!base64) throw new AppError(ERR.NO_FILE, 'JSON 上传需要 data_base64 字段', 400);
  const cleaned = String(base64).replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleaned, 'base64');
  if (!buffer.length) throw new AppError(ERR.NO_FILE, 'data_base64 解码后为空', 400);
  return {
    buffer,
    filename: body.filename || null,
    mime: body.mime || guessMime(body.filename),
    fields: body
  };
}

function guessMime(filename = '') {
  const ext = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    pdf: 'application/pdf'
  }[ext] || 'application/octet-stream';
}
