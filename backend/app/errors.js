/**
 * 统一错误类型。
 *
 * 设计要点：HTTP 层只认 AppError，任何未捕获异常都会被转成 500 INTERNAL，
 * 保证不会把内部堆栈吐给前端（也避免泄漏路径信息）。
 */
export class AppError extends Error {
  /**
   * @param {string} code    机器可读错误码，前端按它分支
   * @param {string} message 面向用户的中文说明
   * @param {number} status  HTTP 状态码
   * @param {object} [details] 附加信息（字段名、允许值等）
   */
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

/** 常用错误码，集中定义避免各处手写字符串时拼错 */
export const ERR = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_EXAM: 'INVALID_EXAM',
  EMPTY_TEXT: 'EMPTY_TEXT',
  NO_FILE: 'NO_FILE',
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SUBMISSION_NOT_FOUND: 'SUBMISSION_NOT_FOUND',
  STUDENT_NOT_FOUND: 'STUDENT_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  OCR_FAILED: 'OCR_FAILED',
  OCR_ENGINE_UNAVAILABLE: 'OCR_ENGINE_UNAVAILABLE',
  TEXT_TOO_SHORT: 'TEXT_TOO_SHORT',
  INTERNAL: 'INTERNAL'
};
