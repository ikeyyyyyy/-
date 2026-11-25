/**
 * 数据模型迁移（版本化、幂等、向后兼容）。
 *
 * 背景：本项目原本没有数据库，批改结果只存在于浏览器内存里。
 * 新增的两个模块需要落库，于是引入「单文件 JSON 存储 + 版本号迁移」：
 *  - 每次启动都从 schema_version 往后跑未执行的迁移；
 *  - 迁移函数必须幂等，重复执行不改变结果；
 *  - 旧数据（版本 1，只有 text 提交）升级后自动补齐新字段的默认值，不需要人工介入。
 *
 * 说明：这是为课程/演示场景选择的轻量方案；生产环境应换成 PostgreSQL，
 * 迁移脚本的语义（add column default / backfill）可以一对一平移。
 */

/** v1：最初的批改记录表结构（只有文本提交，没有 student_id / source_type） */
const m001 = {
  version: 1,
  name: 'init-submissions',
  up(db) {
    db.submissions ??= {};
    db.students ??= {};
    db.schema_version = 1;
  }
};

/**
 * v2：补齐多模态与学习分析所需字段。
 * 关键点：全部给默认值，且只对缺失字段赋值，绝不覆盖已存在的数据。
 */
const m002 = {
  version: 2,
  name: 'add-multimodal-and-analytics-fields',
  up(db) {
    for (const sub of Object.values(db.submissions || {})) {
      sub.student_id ??= null;                 // 旧数据没有学号，保持为空，不影响单篇批改
      sub.source_type ??= 'text';              // 旧数据都来自文本框
      sub.ocr_text ??= null;                   // 未经过 OCR
      sub.normalized_text ??= sub.original_text ?? null;
      sub.preprocess_report ??= null;
      sub.assets ??= [];                       // 原图等二进制资产
      sub.analysis ??= null;                   // 由 record-adapter 计算出的分析字段
      sub.exam_key ??= sub.exam?.key ?? null;
      sub.exam_name ??= sub.exam?.name ?? null;
      sub.total ??= sub.grading?.total ?? null;
      sub.total_max ??= sub.grading?.totalMax ?? null;
      sub.band_label ??= sub.grading?.band?.label ?? null;
    }
    db.schema_version = 2;
  }
};

/** v3：建立按学生聚合的倒排索引，学习分析的读路径只走这里，避免全表扫描 */
const m003 = {
  version: 3,
  name: 'build-by-student-index',
  up(db) {
    const index = { by_student: {} };
    const subs = Object.values(db.submissions || {}).sort(
      (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)
    );
    for (const sub of subs) {
      if (!sub.student_id) continue;           // 匿名/旧数据不进索引，但记录本身保留
      (index.by_student[sub.student_id] ??= []).push(sub.id);
    }
    db.index = index;
    db.schema_version = 3;
  }
};

export const MIGRATIONS = [m001, m002, m003];
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * 依次执行未应用的迁移。
 * @param {object} db 可变数据库对象
 * @returns {{from:number,to:number,applied:string[]}}
 */
export function runMigrations(db) {
  const from = Number(db.schema_version || 0);
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    m.up(db);
    applied.push(`v${m.version}:${m.name}`);
  }
  db.schema_version = LATEST_SCHEMA_VERSION;
  return { from, to: db.schema_version, applied };
}
