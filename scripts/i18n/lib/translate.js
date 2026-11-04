// 机翻缺译条目：只补缺失的部分，已有译文一律不动；写入的译文状态是 needs_review
// 不合格的译文（占位符、专有名词、数字等，规则与 check.js 相同）不写入，只报告

import { createHash } from "node:crypto";
import * as OpenCC from "opencc-js";
import { SOURCE_LANG, isTranslatable, sourceLocOf, unitAt, unitsOf } from "./catalog.js";
import { CJK_LANGS, sourceTextAt, unitIssuesOf } from "./checks.js";
import { specsOf } from "./format.js";
import { maskOf, unmaskOf } from "./mask.js";

const BATCH_SIZE = 150,
  PARALLEL = 4,
  ZWSP_LANGS = new Set(["km", "lo", "th", "my"]),
  FULLWIDTH = { "，": ", ", "。": ". ", "：": ": ", "；": "; ", "！": "! ", "？": "? " };

const pluralRulesOf = (lang) => new Intl.PluralRules(lang),
  pluralCategoriesOf = (lang) => pluralRulesOf(lang).resolvedOptions().pluralCategories;

// 返回 select(n) 等于 category 的最小非负整数；ru、pl 等语言的 other 只用于小数，没有整数示例
const integerSampleOf = (lang, category) => {
  const rules = pluralRulesOf(lang);
  for (let n = 0; n < 1000; n++) if (rules.select(n) === category) return n;
  return null;
};

// 把接口的输出修正成符合规则的写法；返回 null 表示无法修正
export const polishOf = (lang, source, value) => {
  let v = value;
  if (source.includes("…")) v = v.replaceAll("...", "…");
  v = v.replace(/[\ufeff\u202a-\u202e\u2066-\u2069\ufe00-\ufe0f]|\udb40[\udd00-\uddef]/g, "");
  if (!ZWSP_LANGS.has(lang)) v = v.replaceAll("\u200b", "");
  if (!CJK_LANGS.has(lang)) v = v.replace(/[，。：；！？]/g, (c) => FULLWIDTH[c]).replace(/ +$/gm, "");
  const lead = source.match(/^\s*/)[0],
    trail = source.match(/\s*$/)[0];
  return lead + v.trim() + trail;
};

const idOf = (text) => "k" + createHash("sha1").update(text).digest("hex").slice(0, 12);

// 把一批文案写成 YAML：键是原文的 hash（服务端按行缓存，键稳定才能命中缓存），值用 JSON 字符串转义
const yamlOf = (items) => items.map((it) => it.id + ": " + JSON.stringify(it.text)).join("\n") + "\n";

// 解析接口返回的 YAML；整体解析失败时逐行解析
const parseYaml = (text) => {
  try {
    const obj = Bun.YAML.parse(text);
    if (obj && typeof obj === "object") return obj;
  } catch {}
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(k[0-9a-f]+):\s?(.*)$/);
    if (!m) continue;
    try {
      out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
    } catch {
      out[m[1]] = m[2];
    }
  }
  return out;
};

const poolRun = async (tasks, limit) => {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
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
const pluralUnitOf = (lang, entry, key, category) => {
  const n = integerSampleOf(lang, category);
  if (n === null) return null;
  const en_category = pluralRulesOf(SOURCE_LANG).select(n),
    source = sourceTextAt(key, entry, ["plural", en_category]),
    specs = specsOf(source);
  if (specs.length !== 1 || source.replace(specs[0].raw, "").includes("%")) return null;
  const spec = specs[0];
  return {
    text: source.replace(spec.raw, String(n)),
    finish: (out) => {
      // 译文中的数字可能是阿拉伯-印度数字
      const ascii = out.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0),
        hits = [...ascii.matchAll(new RegExp("(?<!\\d)" + n + "(?!\\d)", "g"))];
      if (hits.length !== 1) return null;
      const i = hits[0].index;
      return polishOf(lang, source, out.slice(0, i) + spec.raw + out.slice(i + String(n).length));
    },
    source,
  };
};

// 收集一种语言的待翻译单元：[{ table, key, path, source, text, finish }]；不支持的写进 skipped
export const pendingOf = (catalogs, lang, skipped) => {
  const out = [];
  for (const [table, catalog] of Object.entries(catalogs)) {
    for (const [key, entry] of Object.entries(catalog.strings)) {
      if (!isTranslatable(entry) || entry.extractionState === "stale") continue;
      const src_loc = sourceLocOf(key, entry),
        loc = entry.localizations?.[lang],
        has = unitsOf(loc).some(([u]) => u.value);
      if (src_loc.variations?.plural) {
        // 已有不分复数的译文时视为完整
        if (loc?.stringUnit?.value) continue;
        const have = loc?.variations?.plural ?? {};
        for (const category of pluralCategoriesOf(lang)) {
          if (have[category]?.stringUnit?.value) continue;
          const unit = pluralUnitOf(lang, entry, key, category);
          // 没有整数示例的类别（ru 的 other 只用于小数）在其他类别翻译完后复制
          if (unit) out.push({ table, key, path: ["plural", category], source: unit.source, ...unit });
          else if (integerSampleOf(lang, category) === null) out.push({ table, key, path: ["plural", category], copy: true });
          else skipped.push({ table, key, reason: "复数文案必须只有 1 个计数占位符" });
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
      if (unit) out.push({ table, key, path: [], source, ...unit });
      else skipped.push({ table, key, reason: "文案含 stringsdict 变量或字面量 {数字}，暂不支持" });
    }
  }
  return out;
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

// 翻译一种语言；transport(from, to, path, yaml) 返回译文 YAML
export const translateLang = async ({ catalogs, lang, api_lang, transport, limit = Infinity }) => {
  const report = { lang, written: 0, failed: [], skipped: [] },
    all = pendingOf(catalogs, lang, report.skipped),
    units = all.filter((u) => !u.copy).slice(0, limit),
    copies = all.filter((u) => u.copy);

  // 同一句原文只请求 1 次
  const by_text = new Map();
  for (const u of units) {
    u.id = idOf(u.text);
    if (!by_text.has(u.id)) by_text.set(u.id, { id: u.id, text: u.text });
  }
  const answers = new Map(),
    request = async (items) => {
      const parsed = parseYaml(await transport(SOURCE_LANG, api_lang, "utm/en/strings.yml", yamlOf(items)));
      for (const it of items) if (typeof parsed[it.id] === "string") answers.set(it.id, parsed[it.id]);
    },
    items = [...by_text.values()],
    batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));
  await poolRun(batches.map((b) => () => request(b).catch((err) => report.failed.push({ reason: "请求失败: " + err.message }))), PARALLEL);

  // 收到的译文先修正、再按 check.js 的规则校验；不合格的单独重试 1 次
  const accept = (u) => {
    const raw = answers.get(u.id);
    if (raw === undefined) return null;
    const value = u.finish(raw);
    return value !== null && unitIssuesOf(lang, u.source, value).length === 0 ? value : null;
  };
  const retry = [...new Set(units.filter((u) => accept(u) === null).map((u) => u.id))];
  for (const id of retry) answers.delete(id);
  await poolRun(retry.map((id) => () => request([by_text.get(id)]).catch(() => {})), PARALLEL);

  for (const u of units) {
    const value = accept(u);
    if (value === null) {
      const raw = answers.get(u.id);
      report.failed.push({
        table: u.table,
        key: u.key,
        reason:
          raw === undefined
            ? "接口没有返回这条译文"
            : "译文不合格: " + (unitIssuesOf(lang, u.source, u.finish(raw) ?? raw).map((i) => i.msg).join("；") || "占位符无法还原"),
      });
      continue;
    }
    setUnit(catalogs[u.table], u.key, lang, u.path, value);
    report.written++;
  }

  // 没有整数示例的复数类别：复制 many，没有 many 时复制 other
  for (const c of copies) {
    const plural = catalogs[c.table].strings[c.key].localizations?.[lang]?.variations?.plural ?? {},
      from = plural.many ?? plural.other ?? Object.values(plural)[0];
    if (!from?.stringUnit?.value) {
      report.failed.push({ table: c.table, key: c.key, reason: "复数类别 " + c.path[1] + " 没有可复制的译文" });
      continue;
    }
    setUnit(catalogs[c.table], c.key, lang, c.path, from.stringUnit.value);
    report.written++;
  }
  return report;
};

// 由另一种语言转换得到的语言（zh-HK 由 zh-Hant 转换）：只补缺失的单元
export const deriveLang = ({ catalogs, lang, derive }) => {
  const [from, to] = derive.opencc.split("-"),
    convert = OpenCC.Converter({ from, to }),
    report = { lang, written: 0, failed: [], skipped: [] };
  for (const [table, catalog] of Object.entries(catalogs)) {
    for (const [key, entry] of Object.entries(catalog.strings)) {
      if (!isTranslatable(entry) || entry.extractionState === "stale") continue;
      const base = entry.localizations?.[derive.from],
        loc = entry.localizations?.[lang];
      if (loc?.stringUnit?.value) continue;
      for (const [unit, path] of unitsOf(base)) {
        if (!unit.value || unitAt(loc, path)?.value) continue;
        const value = convert(unit.value),
          issues = unitIssuesOf(lang, sourceTextAt(key, entry, path), value);
        if (issues.length) {
          report.failed.push({ table, key, reason: "转换结果不合格: " + issues.map((i) => i.msg).join("；") });
          continue;
        }
        setUnit(catalog, key, lang, path, value);
        report.written++;
      }
    }
  }
  return report;
};
