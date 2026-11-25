/** 响应helper：统一 JSON 结构、CORS、错误映射。 */
import { AppError, ERR } from '../errors.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',            // 课堂演示/本地开发；生产应收紧为具体域名
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400'
};

export function applyCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS
  });
  res.end(payload);
}

export function ok(res, data, status = 200) {
  sendJson(res, status, { ok: true, ...data });
}

export function fail(res, err) {
  if (err instanceof AppError) {
    sendJson(res, err.status, { ok: false, error: err.toJSON() });
    return;
  }
  // 未预期异常：日志留全量，响应只给通用信息，避免泄漏内部路径
  console.error('[unhandled]', err);
  sendJson(res, 500, {
    ok: false,
    error: { code: ERR.INTERNAL, message: '服务内部错误，请查看服务端日志' }
  });
}

/** 读取请求体，超过上限直接抛 413（不把整个大文件读进内存） */
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError(ERR.PAYLOAD_TOO_LARGE, `请求体超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new AppError(ERR.INVALID_REQUEST, '请求体不是合法的 JSON', 400);
  }
}
