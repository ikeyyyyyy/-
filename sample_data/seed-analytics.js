/**
 * seed 脚本：把 sample_data/essays.json 里 5 篇作文写入批改记录，模拟同一学生的 5 次提交。
 *
 * 幂等：默认情况下如果该学生已有记录就跳过；加 --force 会先删掉该学生的旧记录再重新写入。
 *
 * 用法：
 *   npm run seed
 *   node sample_data/seed-analytics.js --force
 *   node sample_data/seed-analytics.js --student anon_demo_02
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows 下动态 import 必须用 file:// URL，不能直接给绝对路径
const mod = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const { initStore } = await mod('backend/app/store/db.js');
const { ingestRecord, getProfile, getDashboard, removeStudent } = await mod(
  'backend/app/modules/analytics/service.js'
);

const args = process.argv.slice(2);
const force = args.includes('--force');
const studentArgIndex = args.indexOf('--student');
const dataset = JSON.parse(await fs.readFile(path.join(ROOT, 'sample_data/essays.json'), 'utf8'));
const studentId = studentArgIndex > -1 ? args[studentArgIndex + 1] : dataset.student_id;

await initStore();

if (force) {
  const removed = removeStudent(studentId);
  if (removed.removed_submissions) console.log(`已清除旧记录：${removed.removed_submissions} 条`);
}

const existing = getDashboard(studentId);
if (!existing.empty && !force) {
  console.log(`学生 ${studentId} 已有 ${existing.submission_count} 条记录，跳过写入。如需重建请加 --force`);
  process.exit(0);
}

const now = Date.now();
const created = [];
for (const item of dataset.submissions) {
  const at = new Date(now + item.day_offset * 24 * 3600 * 1000).toISOString();
  const res = await ingestRecord({
    text: item.text,
    examKey: item.exam_key,
    studentId,
    createdAt: at,
    meta: { demo_label: item.label, seeded: true, note: 'demo 数据，非真实学生作业' }
  });
  created.push({ ...res, label: item.label });
  console.log(
    `${item.label.padEnd(24)} ${res.total}/${res.total_max}  ${String(res.band_label).split('（')[0]}`
  );
}

const profile = getProfile(studentId);
const dash = getDashboard(studentId);
console.log('\n--- 仪表盘 ---');
console.log('提交数:', dash.submission_count, '| 分数趋势:', dash.score.trend, `(${dash.score.delta > 0 ? '+' : ''}${dash.score.delta} 个百分点)`);
console.log('首篇:', dash.score.first.percent + '%', '-> 最新:', dash.score.latest.percent + '%');
console.log('错误类型 top:', dash.error_categories.totals.slice(0, 4).map(t => `${t.label}×${t.submissions}`).join(', '));

console.log('\n--- 档案 ---');
console.log('画像:', profile.summary);
console.log('顽固错误 Top 3:', profile.stubborn_errors.map(s => `${s.label}(${s.submissions}篇/${s.trend})`).join(', ') || '(无)');
console.log('优势项:', profile.strengths.map(s => `${s.zh} ${s.average}`).join(', '));
console.log('跨篇提示:', profile.hint.available ? profile.hint.text : '(不可用) ' + profile.hint.reason);
console.log('\n查看页面: npm start 后打开 /frontend/src/pages/LearningProfile/index.html?student=' + studentId);
