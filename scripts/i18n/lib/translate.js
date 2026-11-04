// 机翻缺译条目：只补缺失的部分，已有译文一律不动；写入的译文状态是 needs_review
// 不合格的译文（占位符、专有名词、数字、长度等，规则与 check.js 相同）不写入，只报告

import { createHash, randomUUID } from "node:crypto";
import * as OpenCC from "opencc-js";
import { FatalError } from "./api.js";
import { SOURCE_LANG, isTranslatable, sourceLocOf, unitAt, unitsOf } from "./catalog.js";
import {
  CJK_LANGS,
  RTL_LANGS,
  ZWSP_LANGS,
  exceptionMatcherOf,
  lengthIssueOf,
  pluralCategoriesOf,
  singleIntegerOf,
  sourceTextAt,
  unitIssuesOf,
  unitSourceOf,
} from "./checks.js";
import { specsOf } from "./format.js";
import { maskOf, unmaskOf } from "./mask.js";

const BATCH_SIZE = 150,
  PARALLEL = 4,
  FULLWIDTH = { "，": ", ", "。": ". ", "：": ": ", "；": "; ", "！": "! ", "？": "? ", "（": " (", "）": ")" },
  EN_RULES = new Intl.PluralRules(SOURCE_LANG);

// 返回目标语言中属于 category 的示例整数：
// - 优先 1 至 999，因为 0 常被意译成「没有」，数字就消失了；只有 ar 的 zero 这类类别用 0
// - 同一类别中优先选英文属于 other 的数，这样送去翻译的就是 check.js 对照的英文 other
// - ru、pl 等语言的 other 只用于小数，没有整数示例，返回 null
export const integerSampleOf = (lang, category) => {
  const rules = new Intl.PluralRules(lang);
  let first = null;
  for (let n = 1; n < 1000; n++) {
    if (rules.select(n) !== category) continue;
    if (EN_RULES.select(n) === "other") return n;
    first ??= n;
  }
  if (first !== null) return first;
  return rules.select(0) === category ? 0 : null;
};

// 没有整数示例的类别从哪个类别复制：被复制的是 many 时用 other，其他情况用 many
const copySourceOf = (category) => (category === "many" ? "other" : "many");

// 原文用弯引号时，译文换成这种语言的引号。fr 的书名号内侧是不换行空格
const QUOTES = { ja: ["「", "」"], "zh-Hant": ["「", "」"], "zh-HK": ["「", "」"], de: ["„", "“"], fr: ["«\u00a0", "\u00a0»"] },
  QUOTE_MARK_RE = /["“”„«»「」『』]/g,
  quoteCountOf = (s) => s.match(QUOTE_MARK_RE)?.length ?? 0;

// 把接口的输出修正成符合 check.js 规则的写法；修不了的问题留给校验步骤拒绝
export const polishOf = (lang, source, value) => {
  let v = value;
  // 只删除英文中没有的不可见字符（英文中的 emoji 变体选择符要保留）
  const strip = (re) => {
    v = v.replace(re, (c) => (source.includes(c) ? c : ""));
  };
  if (source.includes("…")) v = v.replaceAll("...", "…");
  // 原文只用弯引号时，接口常把 “” 换成 ""，或照搬英文的 “”。成对时按出现顺序换成这种语言的引号
  // 译文已经用了 „ « 「 等本语言写法时不动
  const marks = v.match(/["“”]/g)?.length ?? 0;
  if (/[“”]/.test(source) && !source.includes('"') && !/[„«»「」『』]/.test(v) && marks && marks % 2 === 0) {
    const [open, close] = QUOTES[lang] ?? ["“", "”"];
    let i = 0;
    v = v.replace(/["“”]/g, () => (i++ % 2 ? close : open));
  }
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

// YAML 键是原文的 hash。服务端按行缓存译文，重试时加 salt 换一个键，否则只会拿回同一条坏译文
const idOf = (text, salt = "") => "k" + createHash("sha1").update(salt + "\x00" + text).digest("hex").slice(0, 12);

const ID_LINE_RE = /^(k[0-9a-f]{12}): ?(.*)$/,
  CONTINUATION_RE = /^\s+\S/,
  // 不补引号的值：null 和布尔值。它们解析出的不是字符串，按缺失处理。
  // 以 & ! * 开头的值照常补引号：「&x Text」是正常译文，交给 YAML 会把开头当成锚点或标签吞掉
  YAML_SPECIAL_RE = /^(?:null|~|true|false)$/i;

// 把一批文案写成 YAML，值用 JSON 字符串转义（JSON 字符串也是合法的 YAML 双引号字符串）
export const yamlOf = (items) => items.map((it) => it.id + ": " + JSON.stringify(it.text)).join("\n") + "\n";

// 解析接口返回的 YAML，返回 { id: 字符串 }；内容中没有任何条目行时返回 null（例如网关页面）
// - 接口有时不给值加引号，「{1} …」会被解析成映射，所以先给单行的普通值加上引号
// - 多行的普通值（下一个非空行不是条目行）交给 YAML 解析，不补引号，否则会被截成第 1 行
// - 整体解析失败时，只逐行取单行的双引号值；其余条目按缺失处理，不会把半截或语法写进 catalog
// - 接口常把原文的 “{1}” 换成没转义的 "{1}"（例如 k: "从 "{1}""），整行不是合法的 YAML。这时转义中间的引号再解析
const quotedValueOf = (raw) => {
  for (const s of [raw, raw.length >= 2 && raw.endsWith('"') ? '"' + raw.slice(1, -1).replace(/(?<!\\)"/g, '\\"') + '"' : null]) {
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      if (typeof v === "string") return v;
    } catch {}
  }
  return undefined;
};

export const parseYaml = (text) => {
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => ID_LINE_RE.test(line))) return null;
  // 这一行的值是否延续到后面：跳过空行后，下一个非空行不是条目行
  const continued = (i) => {
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    return j < lines.length && !ID_LINE_RE.test(lines[j]);
  };
  const
    quoted = lines.map((line, i) => {
      const m = line.match(ID_LINE_RE);
      if (!m || continued(i) || /^["'|>]/.test(m[2]) || YAML_SPECIAL_RE.test(m[2])) return line;
      return m[1] + ": " + JSON.stringify(m[2]);
    });
  try {
    const obj = Bun.YAML.parse(quoted.join("\n"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === "string"));
    }
  } catch {}
  const out = {};
  quoted.forEach((line, i) => {
    const m = line.match(ID_LINE_RE);
    if (!m?.[2].startsWith('"') || continued(i)) return;
    const v = quotedValueOf(m[2]);
    if (v !== undefined) out[m[1]] = v;
  });
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

const batchesOf = (items) => {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) out.push(items.slice(i, i + BATCH_SIZE));
  return out;
};

// 普通文案：遮盖占位符后发送，收到后还原
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
// 这个类别只对应 1 个整数时（ar 的 one、two），译文可以省略数字，与 check.js 的规则一致
// 英文写法只有 1 个计数占位符、没有其他 % 时才能代入示例数字
const countSpecOf = (text) => {
  const specs = specsOf(text);
  return specs.length === 1 && !text.replace(specs[0].raw, "").includes("%") ? specs[0] : null;
};

const pluralUnitOf = (lang, entry, key, category, n) => {
  // 发送的英文：示例数字在英文中对应的写法；它没有计数占位符时（例如「One core」），改用英文 other
  // 修正和校验统一对照英文 other，与 check.js 一致
  const other = sourceTextAt(key, entry, ["plural", "other"]),
    natural = sourceTextAt(key, entry, ["plural", EN_RULES.select(n)]),
    sent = countSpecOf(natural) ? natural : other,
    spec = countSpecOf(sent);
  if (!spec || !countSpecOf(other)) return null;
  const may_omit = singleIntegerOf(lang, category),
    out_spec = countSpecOf(other).raw;
  return {
    text: sent.replace(spec.raw, String(n)),
    finish: (out) => {
      // 译文中的数字可能是阿拉伯-印度数字
      const ascii = out.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0),
        hits = [...ascii.matchAll(new RegExp("(?<!\\d)" + n + "(?!\\d)", "g"))];
      if (hits.length === 0 && may_omit) return polishOf(lang, other, out);
      if (hits.length !== 1) return null;
      const i = hits[0].index;
      return polishOf(lang, other, out.slice(0, i) + out_spec + out.slice(i + String(n).length));
    },
  };
};

// 收集一种语言的待翻译单元。返回 { units, copies }：
// units 是 [{ table, key, entry, path, text, finish, fresh }]，copies 是 [{ table, key, entry, path, fresh }]
// fresh 表示这个复数键原来没有任何类别；这种键要么所有类别都写入，要么一个都不写
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
          fresh = !Object.values(have).some((v) => v?.stringUnit?.value),
          key_units = [],
          key_copies = [];
        let ok = true;
        for (const category of pluralCategoriesOf(lang)) {
          if (have[category]?.stringUnit?.value) continue;
          const path = ["plural", category],
            n = integerSampleOf(lang, category);
          if (n === null) {
            key_copies.push({ table, key, entry, path, fresh });
            continue;
          }
          const unit = pluralUnitOf(lang, entry, key, category, n);
          if (unit) key_units.push({ table, key, entry, path, fresh, ...unit });
          else ok = false;
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
      const text = sourceTextAt(key, entry, []);
      if (isShortLabel(text)) {
        skipped.push({ table, key, short: true, reason: "短标签缺少上下文，留给 utm-i18n skill 补译" });
        continue;
      }
      const unit = plainUnitOf(lang, text);
      if (unit) units.push({ table, key, entry, path: [], fresh: false, ...unit });
      else skipped.push({ table, key, reason: "文案含 stringsdict 变量、带 * 的占位符或字面量 {数字}，暂不支持" });
    }
  }
  return { units, copies };
};

// 短标签：不含占位符、最多 SHORT_LABEL_WORDS 个词（只数字母和数字串，「Escape (⎋)」算 1 个词）
// 接口拿不到上下文，短标签常选错义项（Killing 译成「杀人」，Force 译成「力量」），而回译查不出这类错误
// 所以短标签不机翻，留给 utm-i18n skill 按源码上下文补译
const SHORT_LABEL_WORDS = 2;
export const isShortLabel = (text) => !specsOf(text).length && (text.match(/[\p{L}\p{N}]+/gu) ?? []).length <= SHORT_LABEL_WORDS;

// 按键截取：最多 limit 个单元，但不把一个复数键截在类别中间
const limitByKey = (units, limit) => {
  const out = [];
  for (const u of units) {
    const same_key = out.length && out.at(-1).table === u.table && out.at(-1).key === u.key;
    if (out.length >= limit && !same_key) break;
    out.push(u);
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

// 校验 1 条候选译文：规则与例外清单都与 check.js 相同，另外拒绝空串和长度异常；返回 { value } 或 { reason }
// 派生语言（OpenCC 只换字形、不改长度）不检查长度：zh-Hant 的长度在 check.js 中只是警告
const verdictOf = (lang, u, value, { check_length = true, exceptions }) => {
  if (value === null) return { reason: "占位符或示例数字无法还原" };
  if (!value.trim()) return { reason: "译文为空" };
  const source = unitSourceOf(lang, u.key, u.entry, u.path, value),
    issues = unitIssuesOf(lang, source, value).filter((i) => !exceptions.skip(u.table, u.key, lang, i.rule));
  if (issues.length) return { reason: issues.map((i) => i.msg).join("；") };
  // 引号数量必须和英文相同：接口不加引号、译文又首尾带引号时，解析会吞掉 1 对引号（例如 k: "{1}" und "{2}"）
  if (/[“”]/.test(source) && quoteCountOf(value) !== quoteCountOf(source)) return { reason: "引号数量和英文不同" };
  // 机翻偶尔会输出整段无关文字；长度异常在 check.js 中只是警告，这里直接拒绝。例外清单只放行 check.js 的长度范围，不放行明显失控的长度
  const length_ok = !lengthIssueOf(lang, source, value) || exceptions.skip(u.table, u.key, lang, "length");
  if (check_length && (!length_ok || value.length > source.length * 4 + 20)) return { reason: "译文长度异常" };
  return { value };
};

// 翻译一种语言；transport(from, to, path, yaml) 返回译文 YAML。遇到 FatalError（例如 token 无效）时抛出，中止整次运行
export const translateLang = async ({ catalogs, lang, api_lang, transport, limit = Infinity, salt = randomUUID(), exceptions = exceptionMatcherOf([]) }) => {
  const report = { lang, written: 0, failed: [], skipped: [] },
    pending = pendingOf(catalogs, lang, report.skipped),
    units = limitByKey(pending.units, limit),
    included = new Set(units.map((u) => u.table + "\x00" + u.key)),
    texts = [...new Set(units.map((u) => u.text))];

  // 发送一批原文，结果写进 answers；整批失败（包括返回的内容中没有任何条目行）时记下原因
  const send = async (batch, answers, errors, round_salt) => {
    const items = batch.map((text) => ({ id: idOf(text, round_salt), text }));
    try {
      const parsed = parseYaml(await transport(SOURCE_LANG, api_lang, "utm/en/strings.yml", yamlOf(items)));
      if (parsed === null) throw new Error("接口返回的内容无法解析为译文");
      for (const it of items) if (parsed[it.id] !== undefined) answers.set(it.text, parsed[it.id]);
    } catch (err) {
      if (err instanceof FatalError) throw err;
      for (const it of items) errors.set(it.text, err.message);
    }
  };
  const round = async (batch_texts, round_salt) => {
    const answers = new Map(),
      errors = new Map();
    await poolRun(batchesOf(batch_texts).map((b) => () => send(b, answers, errors, round_salt)), PARALLEL);
    return { answers, errors };
  };
  const judge = (u, answers, errors) => {
    if (errors.has(u.text)) return { reason: "请求失败: " + errors.get(u.text) };
    const raw = answers.get(u.text);
    return raw === undefined ? { reason: "接口没有返回这条译文" } : verdictOf(lang, u, u.finish(raw), { exceptions });
  };

  // 第 1 轮用稳定的键（可以命中服务端缓存）；不合格或漏返回的条目，第 2 轮换本次运行专用的键分批重试
  // 整批请求失败的条目不重试，避免接口故障时反复发送
  const r1 = await round(texts, "");
  // 所有批次都失败：多半是网络或 WEBC_API 配置错误，中止整次运行，不再继续其他语言
  if (texts.length && texts.every((text) => r1.errors.has(text))) {
    throw new Error("所有请求都失败（" + r1.errors.get(texts[0]) + "），检查网络和 WEBC_API");
  }
  const first = new Map(units.map((u) => [u, judge(u, r1.answers, r1.errors)])),
    retry = [...new Set(units.filter((u) => !first.get(u).value && !r1.errors.has(u.text)).map((u) => u.text))],
    r2 = await round(retry, salt),
    result = new Map(
      units.map((u) => {
        const a = first.get(u);
        if (a.value !== undefined || !retry.includes(u.text)) return [u, a];
        const b = judge(u, r2.answers, r2.errors);
        return [u, b.value !== undefined ? b : { reason: b.reason + "（第 1 次：" + a.reason + "）" }];
      }),
    );

  // 按键汇总：复制的类别也先算好、校验好；原来没有复数的键任何 1 个类别失败时整键不写
  const groups = new Map(),
    group = (x) => {
      const id = x.table + "\x00" + x.key;
      if (!groups.has(id)) groups.set(id, { units: [], copies: [] });
      return groups.get(id);
    };
  for (const u of units) group(u).units.push(u);
  // 只复制本次处理过的键，或者只缺复制类别的键
  for (const c of pending.copies) {
    const id = c.table + "\x00" + c.key;
    if (included.has(id) || !pending.units.some((u) => u.table === c.table && u.key === c.key)) group(c).copies.push(c);
  }

  for (const { units: key_units, copies } of groups.values()) {
    const plan = key_units.map((u) => ({ x: u, ...result.get(u) }));
    for (const c of copies) {
      const existing = c.entry.localizations?.[lang]?.variations?.plural ?? {},
        from_path = ["plural", copySourceOf(c.path[1])],
        from = plan.find((p) => p.x.path.join() === from_path.join() && p.value !== undefined)?.value ?? existing[from_path[1]]?.stringUnit?.value;
      plan.push({ x: c, ...(from ? verdictOf(lang, c, from, { exceptions }) : { reason: "复数类别 " + c.path[1] + " 的来源 " + from_path[1] + " 没有译文" }) });
    }
    const fresh = plan.some((p) => p.x.fresh),
      any_failed = plan.some((p) => p.value === undefined);
    for (const p of plan) {
      if (p.value !== undefined && !(fresh && any_failed)) {
        setUnit(catalogs[p.x.table], p.x.key, lang, p.x.path, p.value);
        report.written++;
      } else {
        report.failed.push({
          table: p.x.table,
          key: p.x.key,
          reason: p.value === undefined ? p.reason : "同一个键的其他复数类别失败，整键不写入",
        });
      }
    }
  }
  return report;
};

// 派生语言中现在就能转换的单元：[{ table, key, entry, path, value }]
// 只处理普通文案和复数（2 层路径），与 pendingOf 一致
const derivableOf = (catalogs, lang, derive) => {
  const out = [];
  for (const [table, catalog] of Object.entries(catalogs)) {
    for (const [key, entry] of Object.entries(catalog.strings)) {
      if (!isTranslatable(entry) || entry.extractionState === "stale") continue;
      const base = entry.localizations?.[derive.from],
        loc = entry.localizations?.[lang],
        has = unitsOf(loc).some(([u]) => u.value);
      for (const [unit, path] of unitsOf(base)) {
        if (!unit.value || !(path.length === 0 || (path.length === 2 && path[0] === "plural"))) continue;
        // 不分复数的单元只在目标完全没有译文时补；复数单元按类别补，已有的类别不动
        if (path.length === 0 ? has : loc?.stringUnit?.value || unitAt(loc, path)?.value) continue;
        out.push({ table, key, entry, path, value: unit.value });
      }
    }
  }
  return out;
};

export const derivableCountOf = (catalogs, lang, derive) => derivableOf(catalogs, lang, derive).length;

// 由另一种语言转换得到的语言（zh-HK 由 zh-Hant 转换）：只补缺失的单元
export const deriveLang = ({ catalogs, lang, derive, exceptions = exceptionMatcherOf([]) }) => {
  const [from, to] = derive.opencc.split("-"),
    convert = OpenCC.Converter({ from, to }),
    report = { lang, written: 0, failed: [], skipped: [] };
  for (const u of derivableOf(catalogs, lang, derive)) {
    const verdict = verdictOf(lang, u, convert(u.value), { check_length: false, exceptions });
    if (verdict.value === undefined) {
      report.failed.push({ table: u.table, key: u.key, reason: "转换结果不合格: " + verdict.reason });
      continue;
    }
    setUnit(catalogs[u.table], u.key, lang, u.path, verdict.value);
    report.written++;
  }
  return report;
};
