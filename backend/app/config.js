/**
 * 配置层：所有新增模块的开关、路径、OCR 引擎参数都从这里取。
 * 不读取任何硬编码密钥；密钥只能来自环境变量或本地 .env（.env 已被 .gitignore 忽略）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 极简 .env 解析：不引第三方 dotenv，保持零依赖 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 已存在的真实环境变量优先（便于 CI / 容器覆盖）
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(REPO_ROOT, '.env'));

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const resolvePath = (v, dflt) => path.resolve(REPO_ROOT, v && String(v).trim() ? v : dflt);

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '127.0.0.1',
  publicBaseUrl: (process.env.EG_PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  dataDir: resolvePath(process.env.EG_DATA_DIR, './backend/data'),
  uploadDir: resolvePath(process.env.EG_UPLOAD_DIR, './backend/data/uploads'),
  dbFile: resolvePath(process.env.EG_DB_FILE, './backend/data/db.json'),

  maxUploadBytes: Math.round(num(process.env.MAX_UPLOAD_MB, 12) * 1024 * 1024),

  ocr: {
    engine: (process.env.OCR_ENGINE || 'mock').toLowerCase(),
    lang: process.env.OCR_LANG || 'en',
    confidenceThreshold: num(process.env.OCR_CONFIDENCE_THRESHOLD, 0.75),
    paddle: {
      endpoint: process.env.PADDLEOCR_ENDPOINT || '',
      apiKey: process.env.PADDLEOCR_API_KEY || '',
      timeoutMs: num(process.env.PADDLEOCR_TIMEOUT_MS, 20000)
    },
    vlm: {
      endpoint: process.env.VLM_ENDPOINT || '',
      model: process.env.VLM_MODEL || '',
      apiKey: process.env.VLM_API_KEY || '',
      timeoutMs: num(process.env.VLM_TIMEOUT_MS, 45000)
    },
    cloud: {
      provider: process.env.CLOUD_OCR_PROVIDER || '',
      endpoint: process.env.CLOUD_OCR_ENDPOINT || '',
      key: process.env.CLOUD_OCR_KEY || '',
      timeoutMs: num(process.env.CLOUD_OCR_TIMEOUT_MS, 20000)
    }
  },

  analytics: {
    stubbornMinOccurrences: Math.max(2, num(process.env.ANALYTICS_STUBBORN_MIN_OCCURRENCES, 2)),
    strengthMinScore: num(process.env.ANALYTICS_STRENGTH_MIN_SCORE, 7)
  },

  /** 允许上传的 MIME（图片 + PDF），其余一律 415 */
  allowedMime: new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
};

/** 匿名学号白名单：只允许字母数字下划线短横线，杜绝把邮箱/手机号当 ID 传进来 */
export const STUDENT_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
