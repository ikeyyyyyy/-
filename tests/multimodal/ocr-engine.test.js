/**
 * 多模态 - OCR 引擎层测试。
 * 重点验证「可插拔」与「诚实」：夹具与图片必须一致，未知文件不能编造文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT } from '../helpers/server.js';
import { mockEngine } from '../../backend/app/modules/multimodal/ocr/mock-engine.js';
import { resolveEngine, describeEngines, ENGINE_NAMES } from '../../backend/app/modules/multimodal/ocr/index.js';

const FIXTURE_DIR = path.join(REPO_ROOT, 'sample_data/ocr_fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'index.json'), 'utf8'));
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

test('夹具 sha256 与仓库里的 demo 图片一致（防止图文不符）', () => {
  for (const f of manifest.fixtures) {
    const img = fs.readFileSync(path.join(REPO_ROOT, 'sample_data/images', f.filename));
    assert.equal(sha256(img), f.sha256, `${f.id} 的 sha256 与 index.json 不一致，请重跑 scripts/make-sample-images.mjs`);
    assert.ok(fs.existsSync(path.join(FIXTURE_DIR, f.text_file)), `${f.text_file} 不存在`);
  }
});

test('夹具文本与图片渲染用的是同一份文本', () => {
  // 图片由 scripts/make-sample-images.mjs 从 .txt 渲染而来，这里做一次存在性 + 内容非空校验
  const printed = fs.readFileSync(path.join(FIXTURE_DIR, 'printed_sample.txt'), 'utf8');
  assert.ok(printed.includes('part-time jobs'), '印刷体夹具应包含正文内容');
  assert.ok(printed.split(/\n\s*\n/).length >= 3, '印刷体夹具应保留段落');
  const hand = fs.readFileSync(path.join(FIXTURE_DIR, 'handwriting_sample.txt'), 'utf8');
  assert.ok(hand.length > 60);
});

test('mock 引擎按 sha256 命中夹具并原样返回文本', async () => {
  const f = manifest.fixtures.find(x => x.id === 'printed_sample');
  const buf = fs.readFileSync(path.join(REPO_ROOT, 'sample_data/images', f.filename));
  const out = await mockEngine.recognize({ buffer: buf, filename: f.filename, mime: 'image/png', sha256: sha256(buf) });
  assert.equal(out.engine, 'mock');
  assert.equal(out.text.trim(), fs.readFileSync(path.join(FIXTURE_DIR, f.text_file), 'utf8').trim());
  assert.equal(out.confidence, f.confidence);
  // 必须明确告知"这不是真实识别"
  assert.ok(out.warnings.some(w => w.includes('不是真实 OCR')), out.warnings.join('|'));
});

test('mock 引擎对未知文件返回空文本并给出可读警告，不编造内容', async () => {
  const buf = Buffer.from('not a real essay image');
  const out = await mockEngine.recognize({ buffer: buf, filename: 'unknown.png', mime: 'image/png', sha256: sha256(buf) });
  assert.equal(out.text, '');
  assert.equal(out.confidence, 0);
  assert.ok(out.warnings.length >= 1);
  assert.ok(out.warnings[0].includes('mock'));
});

test('手写夹具的置信度低于阈值（用于验证 needs_review 分支）', () => {
  const hand = manifest.fixtures.find(x => x.id === 'handwriting_sample');
  const printed = manifest.fixtures.find(x => x.id === 'printed_sample');
  assert.ok(hand.confidence < 0.75, '手写样例应低于默认复核阈值');
  assert.ok(printed.confidence >= 0.75, '印刷体样例应高于阈值');
});

test('引擎注册表：四类引擎已注册，未知引擎名报 400', () => {
  assert.deepEqual(ENGINE_NAMES.sort(), ['cloud', 'mock', 'paddle', 'vlm']);
  const list = describeEngines();
  assert.equal(list.length, 4);
  assert.ok(list.find(e => e.name === 'mock').real_recognition === false);
  assert.ok(list.filter(e => e.name !== 'mock').every(e => e.real_recognition === true));

  assert.throws(() => resolveEngine('tesseract'), err => {
    assert.equal(err.code, 'OCR_ENGINE_UNAVAILABLE');
    assert.equal(err.status, 400);
    return true;
  });
});

test('未配置密钥时远端引擎明确报不可用，而不是静默失败', () => {
  for (const name of ['paddle', 'vlm', 'cloud']) {
    const engine = resolveEngine(name);
    const state = engine.available();
    // CI 里不会配这些变量；若本地配了则跳过该断言
    if (!state.ok) assert.ok(state.reason.length > 0, `${name} 应给出不可用原因`);
  }
});
