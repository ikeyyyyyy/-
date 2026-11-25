/**
 * 原图/PDF 存储：落盘 + 生成可访问 URL + 记录 sha256 用于追溯与夹具匹配。
 * 只保存必要信息（不含任何个人信息），文件名用 submission_id 重命名，避免原始文件名泄漏。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../config.js';

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf'
};

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function extForMime(mime) {
  return EXT_BY_MIME[mime] || '.bin';
}

/**
 * @returns {Promise<{kind:string, url:string, file:string, mime:string, bytes:number, sha256:string, original_filename:string|null}>}
 */
export async function saveOriginal({ submissionId, buffer, mime, filename }) {
  const ext = extForMime(mime);
  const storedName = `${submissionId}${ext}`;
  const abs = path.join(config.uploadDir, storedName);
  await fsp.mkdir(config.uploadDir, { recursive: true });
  await fsp.writeFile(abs, buffer);
  return {
    kind: 'original',
    // url 走静态路由 /uploads/*，前端可直接 <img src> / <iframe src>
    url: `/uploads/${storedName}`,
    // 数据库里只存相对路径，避免换机器后绝对路径失效，也避免把本机目录结构写进 API
    file: path.relative(process.cwd(), abs).split(path.sep).join('/'),
    mime,
    bytes: buffer.length,
    sha256: sha256(buffer),
    original_filename: filename || null
  };
}

/** 删除资产文件（用于隐私删除），失败不抛出 */
export async function removeAssets(assets = []) {
  const results = [];
  for (const a of assets) {
    if (!a?.file) continue;
    const abs = path.resolve(process.cwd(), a.file);
    try {
      await fsp.unlink(abs);
      results.push({ file: a.file, removed: true });
    } catch (e) {
      results.push({ file: a.file, removed: false, error: e.code || 'ERROR' });
    }
  }
  return results;
}
