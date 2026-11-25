/**
 * 多模态 - 文本级预处理单元测试。
 * 关注两件事：① 该改的形式问题有没有改；② 有没有越界改动学生原意。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { preprocessText, restoreParagraphs, countWords } from '../../backend/app/modules/multimodal/preprocess.js';

test('中文/全角标点统一为英文半角', () => {
  const r = preprocessText('Learning online is convenient，but it needs discipline。', { confidence: 0.95 });
  assert.equal(r.normalized_text, 'Learning online is convenient, but it needs discipline.');
  const punct = r.corrections.find(c => c.type === 'punctuation');
  assert.ok(punct, '应记录 punctuation 修正');
  assert.ok(punct.count >= 2);
});

test('弯引号与全角引号还原为直引号', () => {
  const r = preprocessText('He said “time is money” and left.', { confidence: 0.95 });
  assert.ok(r.normalized_text.includes('"time is money"'), r.normalized_text);
});

test('跨行断词合并：govern-\\nment -> government', () => {
  const r = preprocessText('The gover-\nnment should act now.', { confidence: 0.95 });
  assert.ok(r.normalized_text.includes('government'), r.normalized_text);
  const c = r.corrections.find(x => x.type === 'hyphenation');
  assert.equal(c.count, 1);
});

test('孤立页码与页眉横线被清理', () => {
  const raw = ['English Essay', '', 'Page 2 of 5', '---', '', 'Body starts here.'].join('\n');
  const r = preprocessText(raw, { confidence: 0.9 });
  assert.ok(!r.normalized_text.includes('Page 2 of 5'), r.normalized_text);
  assert.ok(!r.normalized_text.includes('---'), r.normalized_text);
  assert.ok(r.corrections.some(c => c.type === 'layout_noise'));
});

test('空行还原段落', () => {
  const raw = 'First paragraph one.\n\nSecond paragraph two.\n\nThird paragraph three.';
  const r = preprocessText(raw, { confidence: 0.95 });
  assert.equal(r.stats.paragraphs, 3);
  assert.equal(r.normalized_text.split('\n\n').length, 3);
});

test('无空行时按缩进还原段落', () => {
  const raw = '    Intro sentence here.\n    Body line one.\n      New para starts.\n      New para line two.';
  const r = restoreParagraphs(raw);
  assert.ok(r.paragraphs >= 2, `段落数 ${r.paragraphs}`);
});

test('换行包裹的同一段被合并成一段', () => {
  const raw = 'Online learning has changed the way students study because\nit allows them to attend lectures from anywhere in the world.';
  const r = preprocessText(raw, { confidence: 0.95 });
  assert.equal(r.stats.paragraphs, 1);
  assert.ok(r.normalized_text.includes('because it allows'), r.normalized_text);
});

test('低置信度标记 needs_review，但仍返回可用文本', () => {
  const r = preprocessText('This is a short handwritten note about study habits.', { confidence: 0.55, threshold: 0.75 });
  assert.equal(r.needs_review, true);
  assert.ok(r.review_reasons.some(x => x.includes('置信度')));
  assert.ok(r.normalized_text.length > 0);
});

test('引擎不返回置信度时不编造数字', () => {
  const r = preprocessText('Some transcribed text without confidence.', { confidence: null });
  assert.equal(r.confidence, null);
  assert.equal(r.needs_review, true);
  assert.ok(r.review_reasons.some(x => x.includes('未返回置信度')));
});

test('空文本直接标记复核且不抛错', () => {
  const r = preprocessText('   ', { confidence: 0 });
  assert.equal(r.needs_review, true);
  assert.equal(r.stats.words, 0);
  assert.ok(r.warnings.length > 0);
});

test('不改写实词：正常句子逐词保持', () => {
  const src = 'Students should balance part-time work and academic study.';
  const r = preprocessText(src, { confidence: 0.99 });
  assert.equal(r.normalized_text, src);
  assert.equal(r.corrections.length, 0, '干净的文本不应产生任何修正记录');
});

test('OCR 混淆只在安全上下文替换', () => {
  const r = preprocessText('| think T0 is fine.', { confidence: 0.9 });
  assert.ok(r.normalized_text.startsWith('I think'), r.normalized_text);
  assert.ok(r.normalized_text.includes('TO'), r.normalized_text);
  // 正常单词里的 0 不应被动
  const r2 = preprocessText('The room 2040 is open.', { confidence: 0.9 });
  assert.ok(r2.normalized_text.includes('2040'));
});

test('countWords 只数英文词', () => {
  assert.equal(countWords('Hello world, 你好 2024!'), 2);
});
