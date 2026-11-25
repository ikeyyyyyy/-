/**
 * 学习分析模块自有的建议文案库。
 *
 * 边界说明：这里只产出"针对历史错误类型的练习建议"，
 * 不涉及分数计算，也不复制评语模块的三段式文案（那是 index.html 里 buildComment 的职责）。
 * 单篇评语仍然由现有评语模块生成，本模块只在旁边补一句跨篇提示。
 */

/** 按错误类别给的可执行练习建议 */
export const ADVICE_BY_CATEGORY = {
  spelling: '把近几次反复拼错的词抄成一张错词卡，每天早读默写 3 分钟，一周后自测。',
  capitalization: '写完做一次"只查大写"的通读：句首、专有名词、人称代词 I。',
  punctuation: '句末必须有 . ? !；两个完整句之间用句号或分号，不要只用逗号。',
  agreement: '通读时只做一件事：找每个句子的主语，核对谓语动词的单复数与时态是否一致。',
  article: '记住三条：可数名词单数前必须有冠词；特指用 the；复数泛指不加冠词。',
  plural: '整理一张常考可数名词清单（reason / benefit / problem / student / method），造句时刻意加 -s。',
  verb_form: '完成时是 have/has + 过去分词；把 have/has 后面那个动词单独圈出来检查一次。',
  word_class: '固定词性位置：名词前用形容词，动词后用副词；写完逐句核对。',
  chinglish: 'because 与 so、although 与 but 不能同句出现，一个句子只留一个连接词。',
  fragment: 'because / although / which 引导的从句不能单独成句，检查它是否有主句依附。',
  run_on: '超过 25 词的句子在转折处断开，或改成 which 从句；一段里至少留两个短句。',
  comma_splice: '两个完整句之间不能只靠逗号，改成句号、分号，或补 and / but。',
  sentence_variety: '每段安排"一个长句（带从句）+ 两个短句"，避免通篇主谓宾。',
  complex_structure: '每段至少用一次定语从句或状语从句，模板：..., which means that ...',
  vague_wording: '把 good / bad / thing 换成具体词：effective, harmful, measure, policy。',
  cliche: '把 With the development of society 换成具体背景句，例如 In the past decade, ...',
  repetition: '同一关键词出现 3 次以上就换同义表达，或用代词、上位词指代。',
  paragraphing: '固定三段式：观点—论证—结论，每段 4–6 句。',
  cohesion: '每段开头用衔接词：To begin with / Moreover / Admittedly / In conclusion。',
  thesis: '第一段最后一句明确立场，句式：I believe that ... because ...',
  conclusion: '结尾段用 In conclusion 开头，重申立场并补一句展望。',
  evidence: '每个分论点后加 for example，具体到"谁、在哪、做了什么、结果如何"。'
};

/** 按维度给的补强建议（顽固错误不足以解释失分时使用） */
export const ADVICE_BY_DIMENSION = {
  content: '先把题目要求拆成 2–3 个要点，每个要点在正文里必须有一段对应，避免"表态式"论证。',
  structure: '用"主题句 + 解释 + 例子"组织每一段，段尾加一句回扣，让下一段的出现显得必须。',
  lexis: '每天积累 5 个学术搭配（如 play a vital role in / give rise to），并在下一篇里用上 2 个。',
  grammar: '每篇刻意用 2 个非谓语结构和 1 个定语从句，先把结构用对，再追求复杂。',
  mechanics: '交卷前留 2 分钟做"标点与大写"专项检查，这类失分最容易挽回。'
};

export function adviceForCategory(code) {
  return ADVICE_BY_CATEGORY[code] || null;
}

export function adviceForDimension(key) {
  return ADVICE_BY_DIMENSION[key] || null;
}
