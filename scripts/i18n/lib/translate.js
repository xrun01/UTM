// 机翻缺译条目：只补缺失的部分，已有译文一律不动；写入的译文状态是 needs_review
// 不合格的译文（占位符、专有名词、数字等，规则与 check.js 相同）不写入，只报告

import { createHash } from "node:crypto";
import * as OpenCC from "opencc-js";
import { FatalError } from "./api.js";
import { SOURCE_LANG, isTranslatable, sourceLocOf, unitAt, unitsOf } from "./catalog.js";
import { CJK_LANGS, sourceTextAt, unitIssuesOf } from "./checks.js";
import { specsOf } from "./format.js";
import { maskOf, unmaskOf } from "./mask.js";

const BATCH_SIZE = 150,
  PARALLEL = 4,
  ZWSP_LANGS = new Set(["km", "lo", "th", "my"]),
  RTL_LANGS = new Set(["ar", "fa", "he", "iw", "ur", "sd"]),
  FULLWIDTH = { "，": ", ", "。": ". ", "：": ": ", "；": "; ", "！": "! ", "？": "? ", "（": " (", "）": ")" };

const pluralRulesOf = (lang) => new Intl.PluralRules(lang),
  pluralCategoriesOf = (lang) => pluralRulesOf(lang).resolvedOptions().pluralCategories;

// 返回 select(n) 等于 category 的示例整数。优先 1 至 999：0 会被意译成「没有」，数字就消失了；
// 只有 ar 的 zero 这类类别用 0。ru、pl 等语言的 other 只用于小数，没有整数示例，返回 null
export const integerSampleOf = (lang, category) => {
  const rules = pluralRulesOf(lang);
  for (let n = 1; n < 1000; n++) if (rules.select(n) === category) return n;
  return rules.select(0) === category ? 0 : null;
};

// 没有整数示例的类别从哪个类别复制：被复制的是 many 时用 other，其他情况用 many
const copySourceOf = (category) => (category === "many" ? "other" : "many");

// 把接口的输出修正成符合 check.js 规则的写法；修不了的问题留给校验步骤拒绝
export const polishOf = (lang, source, value) => {
  let v = value;
  // 只删除英文中没有的不可见字符（英文中的 emoji 变体选择符要保留）
  const strip = (re) => {
    v = v.replace(re, (c) => (source.includes(c) ? c : ""));
  };
  if (source.includes("…")) v = v.replaceAll("...", "…");
  strip(/[\ufeff\u202a-\u202e\ufe00-\ufe0f]|\udb40[\udd00-\uddef]/g);
  // 从右到左的语言用 Bidi 隔离符包住从左到右的占位符，这是推荐写法
  if (!RTL_LANGS.has(lang)) strip(/[\u2066-\u2069]/g);
  if (!ZWSP_LANGS.has(lang)) strip(/\u200b/g);
  if (!CJK_LANGS.has(lang)) {
    v = v
      .replace(/[，。：；！？（）]/g, (c) => (source.includes(c) ? c : FULLWIDTH[c]))
      .replace(/ {2,}/g, (s) => (source.includes(s) ? s : " "))
      .replace(/ +$/gm, "");
  }
  const lead = source.match(/^\s*/)[0],
    trail = source.match(/\s*$/)[0];
  return lead + v.trim() + trail;
};

// YAML 键是原文的 hash。服务端按行缓存译文，所以重试时加 salt 换一个键，否则只会拿回同一条坏译文
const idOf = (text, salt = "") => "k" + createHash("sha1").update(salt + "\x00" + text).digest("hex").slice(0, 12);

const ID_LINE_RE = /^(k[0-9a-f]{12}): (.*)$/;

// 把一批文案写成 YAML，值用 JSON 字符串转义（JSON 字符串也是合法的 YAML 双引号字符串）
export const yamlOf = (items) => items.map((it) => it.id + ": " + JSON.stringify(it.text)).join("\n") + "\n";

// 解析接口返回的 YAML。接口有时不给值加引号，「{1} …」会被解析成映射，所以先给这种值加上引号；
// 整体解析失败时，只逐行解析双引号值，其余条目按缺失处理，不会把原文写进 catalog
export const parseYaml = (text) => {
  const lines = text.split("\n").map((line) => {
    const m = line.match(ID_LINE_RE);
    return m && !/^["'|>]/.test(m[2]) ? m[1] + ": " + JSON.stringify(m[2]) : line;
  });
  try {
    const obj = Bun.YAML.parse(lines.join("\n"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === "string"));
    }
  } catch {}
  const out = {};
  for (const line of lines) {
    const m = line.match(ID_LINE_RE);
    if (!m?.[2].startsWith('"')) continue;
    try {
      const v = JSON.parse(m[2]);
      if (typeof v === "string") out[m[1]] = v;
    } catch {}
  }
  return out;
};

const poolRun = async (tasks, limit) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) await tasks[next++]();
    }),
  );
};

// 一个待翻译单元：发送 text，收到后用 finish(译文) 得到最终值（null 表示不合格）
const plainUnitOf = (lang, source) => {
  const masked = maskOf(source);
  if (!masked) return null;
  return {
    text: masked.text,
    finish: (out) => {
      const raw = unmaskOf(masked, out);
      return raw === null ? null : polishOf(lang, source, raw);
    },
  };
};

// 复数类别：把计数占位符换成示例数字发送，收到后把数字换回占位符
const pluralUnitOf = (lang, entry, key, category, n) => {
  const source = sourceTextAt(key, entry, ["plural", pluralRulesOf(SOURCE_LANG).select(n)]),
    specs = specsOf(source);
  if (specs.length !== 1 || source.replace(specs[0].raw, "").includes("%")) return null;
  const spec = specs[0];
  return {
    source,
    text: source.replace(spec.raw, String(n)),
    finish: (out) => {
      // 译文中的数字可能是阿拉伯-印度数字；示例数字必须正好出现 1 次
      const ascii = out.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0),
        hits = [...ascii.matchAll(new RegExp("(?<!\\d)" + n + "(?!\\d)", "g"))];
      if (hits.length !== 1) return null;
      const i = hits[0].index;
      return polishOf(lang, source, out.slice(0, i) + spec.raw + out.slice(i + String(n).length));
    },
  };
};

// 收集一种语言的待翻译单元：[{ table, key, path, source, text, finish }]，以及复制项 [{ table, key, path }]
// 不支持的键写进 skipped，每个键只记 1 次
export const pendingOf = (catalogs, lang, skipped = []) => {
  const units = [],
    copies = [];
  for (const [table, catalog] of Object.entries(catalogs)) {
    for (const [key, entry] of Object.entries(catalog.strings)) {
      if (!isTranslatable(entry) || entry.extractionState === "stale") continue;
      const src_loc = sourceLocOf(key, entry),
        loc = entry.localizations?.[lang],
        has = unitsOf(loc).some(([u]) => u.value);
      if (src_loc.variations?.plural) {
        // 已有不分复数的译文时视为完整
        if (loc?.stringUnit?.value) continue;
        const have = loc?.variations?.plural ?? {},
          key_units = [],
          key_copies = [];
        let ok = true;
        for (const category of pluralCategoriesOf(lang)) {
          if (have[category]?.stringUnit?.value) continue;
          const n = integerSampleOf(lang, category);
          if (n === null) {
            key_copies.push({ table, key, path: ["plural", category] });
            continue;
          }
          const unit = pluralUnitOf(lang, entry, key, category, n);
          if (!unit) ok = false;
          else key_units.push({ table, key, path: ["plural", category], ...unit });
        }
        if (!ok) skipped.push({ table, key, reason: "复数文案必须只有 1 个计数占位符" });
        else {
          units.push(...key_units);
          copies.push(...key_copies);
        }
        continue;
      }
      if (Object.keys(src_loc.variations ?? {}).length) {
        if (!has) skipped.push({ table, key, reason: "暂不支持复数以外的 variations" });
        continue;
      }
      if (has) continue;
      const source = sourceTextAt(key, entry, []),
        unit = plainUnitOf(lang, source);
      if (unit) units.push({ table, key, path: [], source, ...unit });
      else skipped.push({ table, key, reason: "文案含 stringsdict 变量、带 * 的占位符或字面量 {数字}，暂不支持" });
    }
  }
  return { units, copies };
};

const setUnit = (catalog, key, lang, path, value) => {
  const entry = catalog.strings[key];
  entry.localizations ??= {};
  if (path.length === 0) {
    entry.localizations[lang] = { stringUnit: { state: "needs_review", value } };
    return;
  }
  const loc = (entry.localizations[lang] ??= {}),
    variants = ((loc.variations ??= {})[path[0]] ??= {});
  variants[path[1]] = { stringUnit: { state: "needs_review", value } };
};

// 翻译一种语言；transport(from, to, path, yaml) 返回译文 YAML。遇到 FatalError（例如 token 无效）时抛出，中止整次运行
export const translateLang = async ({ catalogs, lang, api_lang, transport, limit = Infinity }) => {
  const report = { lang, written: 0, failed: [], skipped: [] },
    pending = pendingOf(catalogs, lang, report.skipped),
    units = pending.units.slice(0, limit),
    attempted = new Set(units.map((u) => u.table + "\x00" + u.key));

  // 同一句原文只请求 1 次
  const texts = new Map();
  for (const u of units) {
    u.id = idOf(u.text);
    texts.set(u.id, u.text);
  }

  // 发送一批 { id, text }，结果写进 answers；整批失败时记下原因
  const send = async (items, answers, errors) => {
    try {
      const parsed = parseYaml(await transport(SOURCE_LANG, api_lang, "utm/en/strings.yml", yamlOf(items)));
      for (const it of items) if (parsed[it.id] !== undefined) answers.set(it.text, parsed[it.id]);
    } catch (err) {
      if (err instanceof FatalError) throw err;
      for (const it of items) errors.set(it.text, err.message);
    }
  };
  const first = new Map(),
    first_err = new Map(),
    items = [...texts].map(([id, text]) => ({ id, text })),
    batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));
  await poolRun(batches.map((b) => () => send(b, first, first_err)), PARALLEL);

  // 修正后按 check.js 的规则校验；返回 { value } 或 { reason }
  const judge = (u, raw) => {
    if (raw === undefined) return { reason: "接口没有返回这条译文" };
    const value = u.finish(raw);
    if (value === null) return { reason: "译文不合格: 占位符或示例数字无法还原" };
    const issues = unitIssuesOf(lang, u.source, value);
    return issues.length ? { reason: "译文不合格: " + issues.map((i) => i.msg).join("；") } : { value };
  };

  // 不合格或漏返回的条目换一个键单独重试 1 次；整批请求失败的条目不重试，避免接口故障时逐条重发
  const retry_text = new Set(units.filter((u) => !first_err.has(u.text) && !judge(u, first.get(u.text)).value).map((u) => u.text)),
    second = new Map(),
    second_err = new Map();
  await poolRun([...retry_text].map((text) => () => send([{ id: idOf(text, "retry"), text }], second, second_err)), PARALLEL);

  for (const u of units) {
    let result = judge(u, first.get(u.text));
    if (first_err.has(u.text)) result = { reason: "请求失败: " + first_err.get(u.text) };
    else if (!result.value && retry_text.has(u.text)) {
      const again = second_err.has(u.text) ? { reason: "重试请求失败: " + second_err.get(u.text) } : judge(u, second.get(u.text));
      result = again.value ? again : { reason: again.reason + "（第 1 次：" + result.reason + "）" };
    }
    if (!result.value) {
      report.failed.push({ table: u.table, key: u.key, reason: result.reason });
      continue;
    }
    setUnit(catalogs[u.table], u.key, lang, u.path, result.value);
    report.written++;
  }

  // 没有整数示例的复数类别（ru 的 other）：复制固定的来源类别；只处理本次翻译过、或来源已有译文的键
  for (const c of pending.copies) {
    const plural = catalogs[c.table].strings[c.key].localizations?.[lang]?.variations?.plural ?? {},
      from = plural[copySourceOf(c.path[1])]?.stringUnit?.value;
    if (from) {
      setUnit(catalogs[c.table], c.key, lang, c.path, from);
      report.written++;
    } else if (attempted.has(c.table + "\x00" + c.key)) {
      report.failed.push({ table: c.table, key: c.key, reason: "复数类别 " + c.path[1] + " 的来源 " + copySourceOf(c.path[1]) + " 没有译文" });
    }
  }
  return report;
};

// 派生语言中现在就能转换的单元：[{ table, key, path, value }]
const derivableOf = (catalogs, lang, derive) => {
  const out = [];
  for (const [table, catalog] of Object.entries(catalogs)) {
    for (const [key, entry] of Object.entries(catalog.strings)) {
      if (!isTranslatable(entry) || entry.extractionState === "stale") continue;
      const base = entry.localizations?.[derive.from],
        loc = entry.localizations?.[lang],
        has = unitsOf(loc).some(([u]) => u.value);
      for (const [unit, path] of unitsOf(base)) {
        // 不分复数的单元只在目标完全没有译文时补；复数单元按类别补，已有的类别不动
        if (!unit.value || (path.length === 0 ? has : loc?.stringUnit?.value || unitAt(loc, path)?.value)) continue;
        out.push({ table, key, path, value: unit.value });
      }
    }
  }
  return out;
};

export const derivableCountOf = (catalogs, lang, derive) => derivableOf(catalogs, lang, derive).length;

// 由另一种语言转换得到的语言（zh-HK 由 zh-Hant 转换）：只补缺失的单元
export const deriveLang = ({ catalogs, lang, derive }) => {
  const [from, to] = derive.opencc.split("-"),
    convert = OpenCC.Converter({ from, to }),
    report = { lang, written: 0, failed: [], skipped: [] };
  for (const { table, key, path, value: base } of derivableOf(catalogs, lang, derive)) {
    const entry = catalogs[table].strings[key],
      value = convert(base),
      issues = unitIssuesOf(lang, sourceTextAt(key, entry, path), value);
    if (issues.length) {
      report.failed.push({ table, key, reason: "转换结果不合格: " + issues.map((i) => i.msg).join("；") });
      continue;
    }
    setUnit(catalogs[table], key, lang, path, value);
    report.written++;
  }
  return report;
};
