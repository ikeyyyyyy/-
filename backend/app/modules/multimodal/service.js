/**
 * 多模态输入与预处理 —— 服务层。
 *
 * 链路：上传 -> 存储原图 -> OCR（可插拔引擎）-> 文本级预处理 -> 【调用现有评分适配器】
 *      -> 落库 -> 返回「与文本批改同构的 grading + preprocess_report」
 *
 * 硬性约束的落地方式：
 *  - 不直接调用/复写任何评分公式：这里唯一与评分相关的调用是 scoringAdapter.gradeEssay()。
 *  - 原图、OCR 原文、标准化文本、预处理报告全部入库，便于追溯与人工复核。
 *  - OCR 置信度低不阻断评分，只置 needs_review。
 */
import { config, STUDENT_ID_PATTERN } from '../../config.js';
import { AppError, ERR } from '../../errors.js';
import * as scoring from '../../adapters/scoring-adapter.js';
import { buildAnalysis } from '../../adapters/record-adapter.js';
import { newSubmissionId, saveSubmission, getSubmission } from '../../store/db.js';
import { resolveEngine } from './ocr/index.js';
import { preprocessText } from './preprocess.js';
import { saveOriginal, removeAssets, sha256, extForMime } from './storage.js';

const MIN_WORDS_TO_GRADE = 5;

function assertStudentId(studentId) {
  if (studentId === undefined || studentId === null || studentId === '') return null;
  const s = String(studentId).trim();
  if (!STUDENT_ID_PATTERN.test(s)) {
    throw new AppError(
      ERR.INVALID_REQUEST,
      'student_id 只允许字母、数字、下划线、短横线（3–64 位），请使用匿名 ID，不要填写真实姓名/邮箱/手机号',
      400
    );
  }
  return s;
}

function assertMime(mime) {
  if (!mime || !config.allowedMime.has(mime)) {
    throw new AppError(ERR.UNSUPPORTED_MEDIA, `不支持的文件类型：${mime || '(未知)'}`, 415, {
      allowed: [...config.allowedMime]
    });
  }
}

function sourceTypeOf(mime) {
  return mime === 'application/pdf' ? 'pdf' : 'image';
}

/**
 * 从上传文件创建一条提交记录。
 * @param {object} input
 * @param {Buffer} input.buffer
 * @param {string} input.filename
 * @param {string} input.mime
 * @param {string} [input.examKey]
 * @param {string} [input.studentId]
 * @param {string} [input.engineName]
 */
export async function createSubmissionFromUpload({
  buffer,
  filename,
  mime,
  examKey = 'cet4',
  studentId = null,
  engineName
}) {
  if (!buffer || !buffer.length) throw new AppError(ERR.NO_FILE, '未收到文件内容', 400);
  if (buffer.length > config.maxUploadBytes) {
    throw new AppError(ERR.PAYLOAD_TOO_LARGE, `文件超过 ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB`, 413);
  }
  assertMime(mime);
  const sid = assertStudentId(studentId);

  const exam = resolveExam(examKey);
  const engine = resolveEngine(engineName);
  const engineState = engine.available();
  if (!engineState.ok) {
    // 引擎没配置好就明确报错，不要静默返回空文本让学生以为"识别失败是作文的问题"
    throw new AppError(ERR.OCR_ENGINE_UNAVAILABLE, engineState.reason, 503, { engine: engine.name });
  }

  const id = newSubmissionId();
  const hash = sha256(buffer);

  let asset;
  try {
    asset = await saveOriginal({ submissionId: id, buffer, mime, filename });
    asset.ext = extForMime(mime);

    const ocr = await engine.recognize({
      buffer,
      filename,
      mime,
      sha256: hash,
      lang: config.ocr.lang
    });

    const report = preprocessText(ocr.text, {
      confidence: ocr.confidence,
      threshold: config.ocr.confidenceThreshold,
      engine: ocr.engine,
      engineWarnings: ocr.warnings,
      imageMeta: ocr.image_meta
    });

    const normalized = report.normalized_text || '';
    if (!normalized || report.stats.words < MIN_WORDS_TO_GRADE) {
      throw new AppError(
        ERR.TEXT_TOO_SHORT,
        `标准化后的文本只有 ${report.stats.words} 词，无法评分。请检查图片是否清晰，或确认 OCR 引擎已正确配置。`,
        422,
        {
          ocr_engine: ocr.engine,
          ocr_text: ocr.text.slice(0, 500),
          normalized_text: normalized.slice(0, 500),
          preprocess_report: report
        }
      );
    }

    // ★ 唯一入口：交给现有评分服务适配器，不在本模块重算任何分数
    const grading = scoring.grade(normalized, exam.key);

    // 拼写「标准化」的正确做法：只标记、不改写。
    // 如果把 student 的拼写错误自动改对，评分引擎就再也发现不了这些错误，
    // 学生也会误以为原文没写错。所以这里复用评分结果里的拼写发现，
    // 把它放进预处理报告供人工核对，正文一个字都不动。
    const spellFinding = (grading.findings || []).find(f => f.dim === 'lexis' && /拼写/.test(f.title));
    report.spelling_flags = spellFinding ? spellFinding.examples.slice(0, 5) : [];
    if (report.spelling_flags.length) {
      report.steps.push({
        name: 'spelling_review',
        applied: false,
        note: `发现 ${report.spelling_flags.length} 处拼写问题，按只标记不改写处理（改写会隐藏学生的真实错误）`
      });
    }

    const createdAt = new Date().toISOString();
    const doc = {
      schema: 'submission@2',
      id,
      student_id: sid,
      source_type: sourceTypeOf(mime),
      created_at: createdAt,
      exam_key: exam.key,
      exam_name: grading.exam.name,
      original_text: null,
      ocr_text: ocr.text,                 // OCR 原始输出，永久保留用于追溯
      normalized_text: normalized,        // 送进评分的那一版
      normalized_text_confirmed: normalized,
      preprocess_report: report,
      confirmed: false,
      edited: false,
      ocr: {
        engine: ocr.engine,
        confidence: ocr.confidence,
        fixture_id: ocr.fixture_id || null
      },
      mime,
      bytes: buffer.length,
      sha256: hash,
      original_filename: filename || null,
      assets: [asset],
      grading,
      analysis: buildAnalysis(grading),
      total: grading.total,
      total_max: grading.totalMax,
      band_label: grading.band.label
    };

    await saveSubmission(doc);
    return { submission: toPayload(doc), created: true };
  } catch (err) {
    // 失败时清掉已落盘的原图，避免留下没有记录的孤儿文件
    if (asset) await removeAssets([asset]);
    throw err;
  }
}

/**
 * 识别结果人工编辑确认：用老师/学生校对后的文本重新走一遍评分，
 * 同时保留原始 ocr_text 与原始 normalized_text，保证「改了什么」可追溯。
 */
export async function confirmSubmission(id, { normalizedText, examKey }) {
  const doc = getSubmission(id);
  if (!doc) throw new AppError(ERR.SUBMISSION_NOT_FOUND, `提交 ${id} 不存在`, 404);

  const text = typeof normalizedText === 'string' ? normalizedText.trim() : '';
  if (!text) throw new AppError(ERR.EMPTY_TEXT, '确认文本不能为空', 400);

  const targetExam = examKey || doc.exam_key;
  const grading = scoring.grade(text, targetExam);

  doc.preprocess_report = {
    ...(doc.preprocess_report || {}),
    needs_review: false,
    review_reasons: [],
    reviewed_at: new Date().toISOString(),
    review_note: '人工确认：文本已由使用者校对后重新评分'
  };
  doc.normalized_text = text;
  doc.normalized_text_confirmed = text;
  doc.confirmed = true;
  doc.edited = text !== doc.ocr_text;
  doc.exam_key = targetExam;
  doc.exam_name = grading.exam.name;
  doc.grading = grading;
  doc.analysis = buildAnalysis(grading);
  doc.total = grading.total;
  doc.total_max = grading.totalMax;
  doc.band_label = grading.band.label;
  doc.updated_at = new Date().toISOString();

  await saveSubmission(doc);
  return { submission: toPayload(doc), created: false };
}

export function getSubmissionPayload(id) {
  const doc = getSubmission(id);
  if (!doc) throw new AppError(ERR.SUBMISSION_NOT_FOUND, `提交 ${id} 不存在`, 404);
  return toPayload(doc);
}

/** 提取 exam 元信息，非法 key 时由适配器抛 400 */
function resolveExam(key) {
  if (!scoring.isExamKey(key)) {
    throw new AppError(ERR.INVALID_EXAM, `未知的评分体系：${key}`, 400, { allowed: scoring.listExamKeys() });
  }
  return { key };
}

/** 内部文档 -> 对外契约（不暴露本机绝对路径等内部字段） */
export function toPayload(doc) {
  const asset = (doc.assets || [])[0] || null;
  return {
    id: doc.id,
    student_id: doc.student_id || null,
    source_type: doc.source_type,
    created_at: doc.created_at,
    exam_key: doc.exam_key,
    exam_name: doc.exam_name,
    original_url: asset ? asset.url : null,
    original_filename: doc.original_filename || null,
    mime: doc.mime || null,
    bytes: doc.bytes ?? null,
    sha256: doc.sha256 || null,
    ocr_engine: doc.ocr?.engine || null,
    ocr_confidence: doc.ocr?.confidence ?? null,
    ocr_text: doc.ocr_text ?? null,
    normalized_text: doc.normalized_text ?? null,
    preprocess_report: doc.preprocess_report || null,
    needs_review: Boolean(doc.preprocess_report?.needs_review),
    review_reasons: doc.preprocess_report?.review_reasons || [],
    confirmed: Boolean(doc.confirmed),
    edited: Boolean(doc.edited),
    // 与文本批改完全同构的批改结果
    grading: doc.grading,
    analysis: doc.analysis || null
  };
}
