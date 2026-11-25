/**
 * 学习分析与个性化档案 —— 服务层。
 *
 * 读路径：只从批改记录表按 student_id 取数据，交给 aggregate.js 纯函数聚合。不写回评分。
 * 写路径：仅提供「记录入库」与「隐私删除」，其中入库会调用现有评分适配器（与多模态同一个），
 *        保证文本提交与图片提交产出同构的记录。
 */
import crypto from 'node:crypto';
import { STUDENT_ID_PATTERN, config } from '../../config.js';
import { AppError, ERR } from '../../errors.js';
import * as scoring from '../../adapters/scoring-adapter.js';
import { buildAnalysis } from '../../adapters/record-adapter.js';
import {
  listByStudent,
  getStudent,
  saveSubmission,
  newSubmissionId,
  deleteStudent as removeStudentRecords
} from '../../store/db.js';
import { buildDashboard, buildProfile, buildTimeline } from './aggregate.js';

function assertStudentId(studentId, { required = true } = {}) {
  if (studentId === undefined || studentId === null || studentId === '') {
    if (!required) return null;
    throw new AppError(ERR.INVALID_REQUEST, '缺少 student_id', 400);
  }
  const s = String(studentId).trim();
  if (!STUDENT_ID_PATTERN.test(s)) {
    throw new AppError(ERR.INVALID_REQUEST, 'student_id 只允许字母、数字、下划线、短横线（3–64 位）', 400);
  }
  return s;
}

export function getDashboard(studentId) {
  const sid = assertStudentId(studentId);
  const subs = listByStudent(sid, { order: 'asc' });
  const dashboard = buildDashboard(subs, { studentId: sid });
  return {
    student_id: sid,
    student_known: Boolean(getStudent(sid)),
    ...dashboard
  };
}

export function getProfile(studentId, { currentSubmissionId = null } = {}) {
  const sid = assertStudentId(studentId);
  const subs = listByStudent(sid, { order: 'asc' });
  const profile = buildProfile(subs, {
    minOccurrences: config.analytics.stubbornMinOccurrences,
    strengthMin: config.analytics.strengthMinScore,
    currentSubmissionId
  });
  return { student_id: sid, student_known: Boolean(getStudent(sid)), ...profile };
}

export function getTimeline(studentId) {
  const sid = assertStudentId(studentId);
  const subs = listByStudent(sid, { order: 'desc' });
  return {
    student_id: sid,
    student_known: Boolean(getStudent(sid)),
    count: subs.length,
    items: buildTimeline(subs),
    empty: subs.length === 0,
    message: subs.length ? undefined : '暂无历史数据'
  };
}

/**
 * 记录入库（文本提交）。由现有前端在批改后调用，或在 seed 脚本里批量写入。
 * 注意：评分依然由 scoring-adapter 完成，本函数只负责落库。
 *
 * 幂等：同一学生提交完全相同的文本时，直接返回已有记录（deduplicated=true），
 * 避免点了两次批阅就多出两条一模一样的记录把趋势图污染。
 */
export async function ingestRecord({ text, examKey = 'cet4', studentId = null, createdAt = null, meta = {} }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new AppError(ERR.EMPTY_TEXT, '作文文本为空', 400);
  }
  const sid = assertStudentId(studentId, { required: false });
  const trimmed = text.trim();
  const textHash = crypto.createHash('sha256').update(trimmed).digest('hex');

  if (sid) {
    const dup = listByStudent(sid).find(x => x.text_hash === textHash);
    if (dup) {
      return {
        submission_id: dup.id,
        student_id: sid,
        created_at: dup.created_at,
        exam_key: dup.exam_key,
        total: dup.total,
        total_max: dup.total_max,
        band_label: dup.band_label,
        deduplicated: true,
        hint: getProfile(sid, { currentSubmissionId: dup.id }).hint
      };
    }
  }

  const grading = scoring.grade(text, examKey);
  const analysis = buildAnalysis(grading);
  const id = newSubmissionId();
  const at = createdAt ? new Date(createdAt).toISOString() : new Date().toISOString();

  const doc = {
    schema: 'submission@2',
    id,
    student_id: sid,
    source_type: 'text',
    created_at: at,
    exam_key: grading.exam.key,
    exam_name: grading.exam.name,
    original_text: text,
    ocr_text: null,
    normalized_text: text,
    normalized_text_confirmed: text,
    preprocess_report: null,
    confirmed: true,
    edited: false,
    assets: [],
    text_hash: textHash,
    grading,
    analysis,
    total: grading.total,
    total_max: grading.totalMax,
    band_label: grading.band.label,
    meta: meta && typeof meta === 'object' ? meta : {}
  };

  await saveSubmission(doc);
  return {
    submission_id: id,
    student_id: sid,
    created_at: at,
    exam_key: doc.exam_key,
    total: doc.total,
    total_max: doc.total_max,
    band_label: doc.band_label,
    deduplicated: false,
    // 入库后立刻回一份提示，前端可以顺手渲染出来
    hint: sid ? getProfile(sid, { currentSubmissionId: id }).hint : null
  };
}

export function removeStudent(studentId) {
  const sid = assertStudentId(studentId);
  return removeStudentRecords(sid);
}
