// 译文的机械检查规则。每个问题是 { level, rule, table, key, lang, msg }
// level：error 会让检查失败；warn 只提示；missing 表示缺译，汇总后作为警告输出

import * as OpenCC from "opencc-js";
import { SOURCE_LANG, isTranslatable, sourceLocOf, unitAt, unitsOf } from "./catalog.js";
import { specMismatchOf, specsOf } from "./format.js";
import { CJK_RE } from "./scan.js";
import { KEEP_TERMS, termIssuesOf } from "./terms.js";

export const CJK_LANGS = new Set(["zh-Hans", "zh-Hant", "zh-HK", "ja", "ko"]);

// 高棉语、老挝语、泰语、缅甸语用 U+200B 标记词边界，删掉会影响换行
export const ZWSP_LANGS = new Set(["km", "lo", "th", "my"]),
  // 从右到左的语言用 Bidi 隔离符（U+2066 至 U+2069）包住从左到右的占位符，这是推荐写法
  RTL_LANGS = new Set(["ar", "fa", "he", "iw", "ur", "sd"]);

const FULLWIDTH_RE = /[，。：；！？（）]/,
  BIDI_EMBED_RE = /[\u202a-\u202e]/,
  BIDI_ISOLATE_RE = /[\u2066-\u2069]/,
  // 变体选择符：粘贴时混入的异体字选择符会让同一个字显示成罕见字形；emoji 的 U+FE0F 在英文中有时合理
  VARIATION_SELECTOR_RE = /[\ufe00-\ufe0f]|\udb40[\udd00-\uddef]/g,
  EDGE_RE = /^(\s*)[\s\S]*?(\s*)$/;

// 繁体中文也是标准写法、但 OpenCC 会逐字转换的字：繁简通用字（平台、批准、公里、干擾、皇后）与异体字
const TRADITIONAL_OK = new Set([..."台游准里裏裡干后云范斗占征余峰峯衆眾着"]),
  cnTo = (to) => OpenCC.Converter({ from: "cn", to }),
  // 地区写法各有异体字（zh-HK 的「說」「戶」、zh-Hant 的「啓」「爲」），只改其中一种转换结果的字不算简体字
  toTraditional = { "zh-Hant": [cnTo("tw"), cnTo("t")], "zh-HK": [cnTo("hk"), cnTo("tw"), cnTo("t")] };

// 逐字检查，返回混入的简体字：这种语言的每个转换器都会改写这个字
const simplifiedCharsOf = (lang, value) => {
  const convs = toTraditional[lang];
  if (!convs) return [];
  return [...new Set([...value].filter((ch) => !TRADITIONAL_OK.has(ch) && convs.every((conv) => conv(ch) !== ch)))];
};

const edgesOf = (s) => {
  const m = s.match(EDGE_RE);
  return [m[1], m[2]];
};

// 去掉占位符后的数字串；阿拉伯-印度数字和全角数字换成 ASCII 数字
const digitsOf = (s) => {
  let text = s;
  for (const spec of specsOf(s).reverse()) text = text.slice(0, spec.start) + " " + text.slice(spec.end);
  return (
    text
      .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660)
      .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0)
      .replace(/[０-９]/g, (d) => d.charCodeAt(0) - 0xff10)
      .match(/\d+/g) ?? []
  );
};

// 英文中的每个数字都必须出现在译文中；译文可以多出数字（日文把 "one or more" 写成「1つ以上」）
const missingDigitsOf = (source, value) => {
  const pool = digitsOf(value);
  return digitsOf(source).filter((d) => {
    const i = pool.indexOf(d);
    if (i < 0) return true;
    pool.splice(i, 1);
    return false;
  });
};

// 译文中有、英文中没有的字符
const addedOf = (source, value, re) => [...(value.match(re) ?? [])].filter((c) => !source.includes(c));

// 译文变体对应的英文：同名变体优先；复数类别英文没有时用 other；英文没有变体时用整句
export const sourceTextAt = (key, entry, path) => {
  const src = sourceLocOf(key, entry);
  if (path.length === 0) return src.stringUnit?.value ?? key;
  return (
    unitAt(src, path)?.value ??
    unitAt(src, [...path.slice(0, -1), "other"])?.value ??
    src.stringUnit?.value ??
    key
  );
};

// 检查 1 条译文；返回 [{ rule, msg }]，全部是 error 级别
export const unitIssuesOf = (lang, source, value) => {
  const out = [],
    add = (rule, msg) => out.push({ rule, msg }),
    spec = specMismatchOf(source, value);
  if (spec) add("format", spec);
  if (source.split("\n").length !== value.split("\n").length) add("newline", "换行数和英文不同");
  const [sl, st] = edgesOf(source),
    [vl, vt] = edgesOf(value);
  if (sl !== vl || st !== vt) add("edge-space", "首尾空白和英文不同");
  if (source.includes("…") && value.includes("...")) add("ellipsis", "省略号 … 被改写成了 ...");
  if (addedOf(source, value, ZWSP_LANGS.has(lang) ? /\ufeff/g : /[\ufeff\u200b]/g).length) add("invisible", "含零宽字符");
  if (addedOf(source, value, VARIATION_SELECTOR_RE).length) add("invisible", "含变体选择符");
  if (BIDI_EMBED_RE.test(value) || (!RTL_LANGS.has(lang) && BIDI_ISOLATE_RE.test(value))) add("bidi", "含 Bidi 控制字符");
  const simplified = simplifiedCharsOf(lang, value);
  if (simplified.length) add("simplified", "繁体译文混入简体字 " + simplified.join("、"));
  if (!CJK_LANGS.has(lang)) {
    if (FULLWIDTH_RE.test(value) && !FULLWIDTH_RE.test(source)) add("fullwidth", "非中日韩语言出现全角标点");
    if (CJK_RE.test(value) && !CJK_RE.test(source)) add("cjk-leftover", "残留中日韩文字");
  }
  const lost = missingDigitsOf(source, value);
  if (lost.length) add("digits", "译文缺少英文中的数字 " + lost.join("、"));
  for (const { term, msg } of termIssuesOf(source, value)) add("term:" + term, msg);
  return out;
};

// 长度比例阈值来自迁移时的实测分布（2026-11-04，3179 条译文）：
// 中日韩的中位数是 0.44，没有超过 1.5 的；其他语言的中位数是 1.14，第 99 百分位是 2.2
const LENGTH_MIN_SOURCE = 10,
  LENGTH_RANGE = { cjk: [0.15, 1.5], other: [0.3, 2.5] };

// 长度异常通常是漏译半句或撑破界面，所以只给警告
export const lengthIssueOf = (lang, source, value) => {
  if (source.length < LENGTH_MIN_SOURCE) return null;
  const [lo, hi] = LENGTH_RANGE[CJK_LANGS.has(lang) ? "cjk" : "other"],
    ratio = value.length / source.length;
  if (ratio >= lo && ratio <= hi) return null;
  return "译文长度是英文的 " + ratio.toFixed(2) + " 倍，超出 " + lo + " 至 " + hi + "，检查是否漏译或撑破界面";
};

// 复数类别：按 CLDR 规则，这种语言需要的类别都要有，缺少时运行时会退回 other
export const pluralCategoriesOf = (lang) => new Intl.PluralRules(lang).resolvedOptions().pluralCategories;

// 这个复数类别在这种语言里是否只对应 1 个整数（ar 的 zero、one、two，de 的 one）；这时译文可以省略数字
export const singleIntegerOf = (lang, category) => {
  const rules = new Intl.PluralRules(lang);
  let n = 0;
  for (let i = 0; i <= 200 && n < 2; i++) if (rules.select(i) === category) n++;
  return n === 1;
};

// 复数变体对照的英文：统一用英文的 other，因为英文的 one 可能写成「One core」；
// 只对应 1 个整数的类别省略了计数占位符时，对照去掉占位符的英文
const pluralSourceOf = (lang, key, entry, path, value) => {
  const src = sourceTextAt(key, entry, [...path.slice(0, -1), "other"]),
    specs = specsOf(src);
  if (specs.length === 1 && specsOf(value).length === 0 && singleIntegerOf(lang, path.at(-1))) {
    // 去掉占位符后合并多出的空格，首尾空白保持英文原样
    const [lead, trail] = edgesOf(src),
      rest = (src.slice(0, specs[0].start) + src.slice(specs[0].end)).replace(/ {2,}/g, " ").trim();
    return lead + rest + trail;
  }
  return src;
};

// 1 条译文应该和哪段英文比较；check.js 和 translate.js 用同一个标准
export const unitSourceOf = (lang, key, entry, path, value) =>
  path[0] === "plural" ? pluralSourceOf(lang, key, entry, path, value) : sourceTextAt(key, entry, path);

// 可以写例外的规则：报错规则，以及 3 条警告（审过的警告可以消掉，避免每次检查都被同样的警告淹没）
// 源码字面量的例外按文件和文字匹配
export const EXCEPTION_RULES = new Set([
  "length",
  "plural",
  "should-translate",
  "format",
  "empty",
  "newline",
  "edge-space",
  "ellipsis",
  "invisible",
  "bidi",
  "simplified",
  "fullwidth",
  "cjk-leftover",
  "digits",
  "source-cjk-literal",
]);

// 校验例外清单；返回问题描述列表
export const exceptionProblemsOf = (exceptions) => {
  if (!Array.isArray(exceptions)) return ["例外清单必须是数组"];
  const out = [];
  exceptions.forEach((e, i) => {
    const where = "第 " + (i + 1) + " 条：";
    if (!e || typeof e !== "object") return out.push(where + "必须是对象");
    if (typeof e.reason !== "string" || !e.reason.trim()) out.push(where + "缺少 reason");
    const term_ok = typeof e.rule === "string" && e.rule.startsWith("term:") && KEEP_TERMS.includes(e.rule.slice(5));
    if (!EXCEPTION_RULES.has(e.rule) && !term_ok) out.push(where + "rule 不是可以写例外的规则: " + e.rule);
    if (e.rule === "source-cjk-literal") {
      if (typeof e.file !== "string" || typeof e.text !== "string") out.push(where + "source-cjk-literal 必须写 file 和 text");
    } else if (typeof e.table !== "string" || typeof e.key !== "string") out.push(where + "必须写 table 和 key");
  });
  return out;
};

// 例外清单：catalog 的例外是 { table, key, lang?, rule, reason }，lang 省略时对所有语言生效；
// 源码字面量的例外是 { file, text, rule: "source-cjk-literal", reason }
export const exceptionMatcherOf = (exceptions) => {
  const used = new Set(),
    hit = (pred) => {
      const i = exceptions.findIndex(pred);
      if (i >= 0) used.add(i);
      return i >= 0;
    };
  return {
    skip: (table, key, lang, rule) =>
      hit((e) => e.table === table && e.key === key && e.rule === rule && (e.lang === undefined || e.lang === lang)),
    skipLiteral: (file, text) => hit((e) => e.rule === "source-cjk-literal" && e.file === file && e.text === text),
    unused: () => exceptions.filter((_, i) => !used.has(i)),
  };
};

// 检查 1 个 catalog；langs 是要检查的语言，known 是 languages.json 中的全部语言
export const catalogIssuesOf = (table, catalog, { langs, known, exceptions = exceptionMatcherOf([]) }) => {
  const out = [],
    add = (level, rule, key, lang, msg) => {
      if (level === "missing" || !exceptions.skip(table, key, lang, rule)) out.push({ level, rule, table, key, lang, msg });
    };

  for (const [key, entry] of Object.entries(catalog.strings)) {
    if (entry.extractionState === "stale") add("error", "stale", key, null, "键已不在源码中，运行 sync.js 删除");
    for (const [, path] of unitsOf(sourceLocOf(key, entry))) {
      if (CJK_RE.test(sourceTextAt(key, entry, path))) add("error", "source-cjk", key, SOURCE_LANG, "英文原文含中日韩文字");
    }
    const translatable = isTranslatable(entry);
    if (!translatable && /\p{L}/u.test(sourceTextAt(key, entry, []))) {
      add("warn", "should-translate", key, null, "标为不翻译，但英文有文字；确认是否需要翻译");
    }
    for (const [lang, loc] of Object.entries(entry.localizations ?? {})) {
      if (lang !== SOURCE_LANG && !known.has(lang)) add("error", "unknown-lang", key, lang, "语言不在 i18n/languages.json 中");
      // substitutions（多参数复数）的变体不在 unitsOf 的遍历范围内，检查和翻译脚本都无法覆盖
      if (loc.substitutions) add("error", "substitutions", key, lang, "暂不支持 substitutions，改成每个复数只有 1 个参数的文案");
    }

    for (const lang of langs) {
      const loc = entry.localizations?.[lang],
        units = unitsOf(loc).filter(([u]) => u.value !== undefined);
      if (units.length === 0) {
        // 标为不翻译的条目不算缺译；它已有的译文仍会编译进 app，所以下面照样检查
        if (translatable) add("missing", "missing", key, lang, "缺译");
        continue;
      }
      for (const [unit, path] of units) {
        const src = unitSourceOf(lang, key, entry, path, unit.value);
        // 空串会编译进 app，界面上显示空白，而不是英文
        if (unit.value === "") {
          if (src !== "") add("error", "empty", key, lang, "译文是空串，app 中会显示空白；补上译文，或删除这条译文");
          continue;
        }
        for (const { rule, msg } of unitIssuesOf(lang, src, unit.value)) add("error", rule, key, lang, msg);
        const length_msg = lengthIssueOf(lang, src, unit.value);
        if (length_msg) add("warn", "length", key, lang, length_msg);
      }
      const cats = pluralCategoriesOf(lang),
        plural = loc?.variations?.plural;
      if (plural) {
        const lack = cats.filter((c) => !plural[c]);
        if (lack.length) add("warn", "plural", key, lang, "缺少复数类别 " + lack.join("、") + "，运行时会退回 other");
      } else if (sourceLocOf(key, entry).variations?.plural && cats.length > 1) {
        add("warn", "plural", key, lang, "英文区分复数，译文只有 1 种形式；这种语言需要 " + cats.join("、"));
      }
    }
  }
  return out;
};
