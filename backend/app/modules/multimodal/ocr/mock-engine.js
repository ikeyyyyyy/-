/**
 * mock OCR 引擎：只回放 sample_data/ocr_fixtures 里的 demo 转录。
 *
 * 它不识别图片，也不做任何推断——按文件 sha256 精确匹配夹具，命中就返回夹具里的文本，
 * 没命中就返回空文本 + needs_review。这样做的目的是：
 *  1. 课堂演示与自动化测试可以离线跑，不需要 OCR 服务、不需要密钥；
 *  2. 绝不伪造识别结果：返回体里 engine='mock'，并且每条 warning 都写明"这是回放，不是识别"。
 * 生产环境请把 OCR_ENGINE 切到 paddle / vlm / cloud。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../../config.js';

const FIXTURE_DIR = path.join(REPO_ROOT, 'sample_data', 'ocr_fixtures');
const MANIFEST = path.join(FIXTURE_DIR, 'index.json');

let manifestCache = null;

function loadManifest() {
  if (manifestCache) return manifestCache;
  if (!fs.existsSync(MANIFEST)) return { fixtures: [] };
  manifestCache = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  return manifestCache;
}

export const mockEngine = {
  name: 'mock',

  available() {
    return { ok: true, reason: 'mock 引擎仅回放 demo 夹具，不执行真实识别' };
  },

  async recognize({ buffer, filename, sha256 }) {
    const manifest = loadManifest();
    const fixture =
      manifest.fixtures.find(f => f.sha256 && f.sha256 === sha256) ||
      manifest.fixtures.find(f => f.filename && path.basename(filename || '') === f.filename);

    if (!fixture) {
      return {
        engine: 'mock',
        text: '',
        confidence: 0,
        warnings: [
          '未命中 demo 夹具：mock 引擎不具备真实识别能力，请配置 OCR_ENGINE=paddle|vlm|cloud 后再上传',
          `未匹配文件：${filename || '(未知)'} sha256=${(sha256 || '').slice(0, 12)}…`
        ],
        image_meta: null
      };
    }

    const textPath = path.join(FIXTURE_DIR, fixture.text_file);
    const text = fs.existsSync(textPath) ? fs.readFileSync(textPath, 'utf8') : '';

    return {
      engine: 'mock',
      text,
      // 这是夹具里写死的 demo 数值，不是真实 OCR 置信度
      confidence: typeof fixture.confidence === 'number' ? fixture.confidence : null,
      warnings: [
        'engine=mock：文本来自 demo 夹具回放，不是真实 OCR 识别结果',
        'confidence 为夹具中的 demo 配置值，不代表真实识别质量'
      ],
      // 图像级处理结果同样由夹具声明，mock 不做任何像素运算
      image_meta: fixture.image_meta || null,
      fixture_id: fixture.id,
      fixture_kind: fixture.kind || null
    };
  }
};
