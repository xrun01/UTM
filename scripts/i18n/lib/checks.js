// 译文的机械检查规则。每个问题是 { level, rule, table, key, lang, msg }
// level：error 会让检查失败；warn 只提示；missing 表示缺译，汇总后作为警告输出

import * as OpenCC from "opencc-js";
import { SOURCE_LANG, isTranslatable, sourceLocOf, unitAt, unitsOf } from "./catalog.js";
import { specMismatchOf, specsOf } from "./format.js";
import { CJK_RE } from "./scan.js";
import { termIssuesOf } from "./terms.js";

export const CJK_LANGS = new Set(["zh-Hans", "zh-Hant", "zh-HK", "ja", "ko"]);

// 高棉语、老挝语、泰语、缅甸语用 U+200B 标记词边界，删掉会影响换行
const ZWSP_LANGS = new Set(["km", "lo", "th", "my"]);

const FULLWIDTH_RE = /[，。：；！？]/,
  BIDI_RE = /[‪-‮⁦-⁩]/,
  // 变体选择符：粘贴时混入的异体字选择符会让同一个字显示成罕见字形
  VARIATION_SELECTOR_RE = /[︀-️]|\udb40[\udd00-\uddef]/,
  EDGE_RE = /^(\s*)[\s\S]*?(\s*)$/;

// 繁体中文也常用、但 OpenCC 会转换的字：「平台」的台、「游标」的游
const TRADITIONAL_OK = new Set(["台", "游"]),
  toTraditional = {
    "zh-Hant": OpenCC.Converter({ from: "cn", to: "tw" }),
    "zh-HK": OpenCC.Converter({ from: "cn", to: "hk" }),
  };

// 逐字检查，返回混入的简体字
const simplifiedCharsOf = (lang, value) => {
  const conv = toTraditional[lang];
  if (!conv) return [];
  return [...new Set([...value].filter((ch) => !TRADITIONAL_OK.has(ch) && conv(ch) !== ch))];
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
  if (value.includes("﻿") || (!ZWSP_LANGS.has(lang) && value.includes("​"))) add("invisible", "含零宽字符");
  if (VARIATION_SELECTOR_RE.test(value)) add("invisible", "含变体选择符");
  if (BIDI_RE.test(value)) add("bidi", "含 Bidi 控制字符");
  const simplified = simplifiedCharsOf(lang, value);
  if (simplified.length) add("simplified", "繁体译文混入简体字 " + simplified.join("、"));
  if (!CJK_LANGS.has(lang)) {
    if (FULLWIDTH_RE.test(value)) add("fullwidth", "非中日韩语言出现全角标点");
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
const pluralCategoriesOf = (lang) => new Intl.PluralRules(lang).resolvedOptions().pluralCategories;

// 例外清单：{ table, key, lang?, rule, reason }；lang 省略时对所有语言生效
export const exceptionMatcherOf = (exceptions) => {
  const used = new Set();
  return {
    skip: (table, key, lang, rule) => {
      const i = exceptions.findIndex(
        (e) => e.table === table && e.key === key && e.rule === rule && (e.lang === undefined || e.lang === lang),
      );
      if (i >= 0) used.add(i);
      return i >= 0;
    },
    unused: () => exceptions.filter((_, i) => !used.has(i)),
  };
};

// 检查 1 个 catalog；langs 是要检查的语言，known 是 languages.json 中的全部语言
export const catalogIssuesOf = (table, catalog, { langs, known, exceptions = exceptionMatcherOf([]) }) => {
  const out = [],
    add = (level, rule, key, lang, msg) => {
      if (level !== "error" || !exceptions.skip(table, key, lang, rule)) out.push({ level, rule, table, key, lang, msg });
    };

  for (const [key, entry] of Object.entries(catalog.strings)) {
    if (entry.extractionState === "stale") add("error", "stale", key, null, "键已不在源码中，运行 sync.js 删除");
    for (const [, path] of unitsOf(sourceLocOf(key, entry))) {
      if (CJK_RE.test(sourceTextAt(key, entry, path))) add("error", "source-cjk", key, SOURCE_LANG, "英文原文含中日韩文字");
    }
    for (const lang of Object.keys(entry.localizations ?? {})) {
      if (lang !== SOURCE_LANG && !known.has(lang)) add("error", "unknown-lang", key, lang, "语言不在 i18n/languages.json 中");
    }
    if (!isTranslatable(entry)) continue;

    for (const lang of langs) {
      const loc = entry.localizations?.[lang],
        units = unitsOf(loc).filter(([u]) => u.value !== undefined && u.value !== "");
      if (units.length === 0) {
        add("missing", "missing", key, lang, "缺译");
        continue;
      }
      for (const [unit, path] of units) {
        const src = sourceTextAt(key, entry, path);
        for (const { rule, msg } of unitIssuesOf(lang, src, unit.value)) add("error", rule, key, lang, msg);
        const length_msg = lengthIssueOf(lang, src, unit.value);
        if (length_msg) add("warn", "length", key, lang, length_msg);
      }
      const plural = loc?.variations?.plural;
      if (plural) {
        const lack = pluralCategoriesOf(lang).filter((c) => c !== "zero" && !plural[c]);
        if (lack.length) add("warn", "plural", key, lang, "缺少复数类别 " + lack.join("、") + "，运行时会退回 other");
      }
    }
  }
  return out;
};
