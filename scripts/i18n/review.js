#!/usr/bin/env bun
// 审校辅助：导出待审条目、写回审校结果、生成回译与比对输入、生成审校报告
// 用法见 .agents/skills/utm-i18n/SKILL.md 的「流程 3：审校」

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CATALOG_PATHS, readCatalog, unitAt, unitsOf, writeCatalog } from "./lib/catalog.js";
import { exceptionMatcherOf, exceptionProblemsOf, sourceTextAt, unitIssuesOf, unitSourceOf } from "./lib/checks.js";
import { reportHtmlOf } from "./lib/report.js";

const USAGE = `用法：
  review.js new-keys --out <file>
  review.js export --lang <code> --out <file> [--state needs_review|translated|all] [--table <表名>] [--key <正则>] [--keys <file>] [--limit <n>]
  review.js apply --lang <code> --proposal <file> [--dry-run]
  review.js back-input --proposal <file> --out <file> [--ids-file <file>]
  review.js compare-input --dir <目录> --langs <code,code> --out <file>
  review.js report --dir <目录> --langs <code,code> --out <file>`;

// 改稿代理只修这 5 类问题
const CHANGE_TYPES = ["语义错误", "术语错误", "漏译", "文字系统错误", "不通顺"];

const [cmd, ...rest] = process.argv.slice(2);
let opt;
try {
  ({ values: opt } = parseArgs({
    args: rest,
    options: {
      root: { type: "string", default: resolve(import.meta.dirname, "../..") },
      lang: { type: "string" },
      langs: { type: "string" },
      out: { type: "string" },
      proposal: { type: "string" },
      dir: { type: "string" },
      state: { type: "string", default: "needs_review" },
      table: { type: "string" },
      key: { type: "string" },
      keys: { type: "string" },
      limit: { type: "string" },
      "ids-file": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  }));
} catch (err) {
  console.error(err.message + "\n" + USAGE);
  process.exit(2);
}

const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};
const need = (...names) => {
  const lack = names.filter((n) => opt[n] === undefined);
  if (lack.length) fail("缺少参数 --" + lack.join("、--") + "\n" + USAGE, 2);
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return fail(path + " 无法读取或不是合法的 JSON：" + err.message, 2);
  }
};
// 写输出文件前先建目录
const writeOut = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const root = resolve(opt.root),
  languages = () => JSON.parse(readFileSync(join(root, "i18n/languages.json"), "utf8")).languages.map((l) => l.code),
  catalogs = () => Object.fromEntries(Object.entries(CATALOG_PATHS).map(([t, p]) => [t, readCatalog(join(root, p))]));

const checkLang = (lang) => {
  const known = languages();
  if (!known.includes(lang)) fail("未知语言: " + lang + "。可选: " + known.join(", "), 2);
};

// 条目 id：表名|键|变体路径。键本身是英文句子，所以必须带上表名和路径才唯一
const idOf = (table, key, path) => [table, key, path.join("/")].join("|");
const parseId = (id) => {
  if (typeof id !== "string") return null;
  const first = id.indexOf("|"),
    last = id.lastIndexOf("|");
  if (first < 0 || first === last) return null;
  const path = id.slice(last + 1);
  return { table: id.slice(0, first), key: id.slice(first + 1, last), path: path ? path.split("/") : [] };
};

// 回译用的不透明 id：条目 id 里有英文原文，回译代理看到就失去了检查作用
// 映射 { 不透明 id: { id, text } } 写在语言目录的 back-ids.json；text 是送去回译时的译文，用来判断回译是否过期
const backIdOf = (id, text) => "b" + createHash("sha1").update(id + "\x00" + text).digest("hex").slice(0, 10);
const BACK_IDS = "back-ids.json";

// 合并 <dir> 下的 back.json、back2.json……（后一轮覆盖前一轮），按 back-ids.json 还原条目 id
// 返回 Map<条目 id, { back, note, text }>；未知 id 写进 warnings
const latestBackOf = (dir, warnings = []) => {
  const ids = existsSync(join(dir, BACK_IDS)) ? readJson(join(dir, BACK_IDS)) : {},
    files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^back\d*\.json$/.test(f))
          .sort((a, b) => (parseInt(a.slice(4)) || 1) - (parseInt(b.slice(4)) || 1))
      : [],
    out = new Map();
  for (const f of files) {
    for (const b of readJson(join(dir, f))) {
      const m = ids[b?.id];
      if (!m) warnings.push(f + "：未知的回译 id " + JSON.stringify(b?.id));
      else out.set(m.id, { back: b.back ?? "", note: b.note ?? "", text: m.text });
    }
  }
  return out;
};

// proposal 当前要写入的条目：{ 条目 id: 译文 }
const currentTextOf = (proposal) =>
  new Map([...(proposal.changes ?? []).map((c) => [c.id, c.new]), ...(proposal.approved ?? []).map((a) => [a.id, a.value])]);

// 校验 proposal 的结构；返回问题描述列表
const proposalProblemsOf = (p) => {
  const out = [],
    seen = new Map(),
    isText = (v) => typeof v === "string";
  if (!p || typeof p !== "object") return ["proposal 必须是对象"];
  if (!isText(p.lang)) out.push("缺少 lang");
  for (const name of ["changes", "approved", "doubts", "source_issues", "withdrawn"]) {
    if (p[name] !== undefined && !Array.isArray(p[name])) out.push(name + " 必须是数组");
  }
  if (out.length) return out;
  const claim = (list, item, i) => {
    const parsed = parseId(item?.id);
    if (!parsed) return out.push(list + " 第 " + (i + 1) + " 条：id 格式不对");
    // 表名必须存在：带语言前缀的 id（例如比对代理输出的 de|Localizable|…）会绕过重复检查
    if (!CATALOG_PATHS[parsed.table]) return out.push(list + " 第 " + (i + 1) + " 条：id 的表名不对：" + item.id);
    // 同一条目只能出现在 changes、approved、doubts、withdrawn 中的 1 处
    if (seen.has(item.id)) out.push(item.id + "：同时出现在 " + seen.get(item.id) + " 和 " + list);
    else seen.set(item.id, list);
  };
  (p.changes ?? []).forEach((c, i) => {
    claim("changes", c, i);
    if (!isText(c?.old)) out.push("changes 第 " + (i + 1) + " 条：缺少 old");
    if (!isText(c?.new) || !c.new.trim()) out.push("changes 第 " + (i + 1) + " 条：new 必须是非空字符串");
    if (!CHANGE_TYPES.includes(c?.type)) out.push("changes 第 " + (i + 1) + " 条：type 必须是 " + CHANGE_TYPES.join("、") + " 之一");
    if (isText(c?.old) && c?.new === c.old) out.push("changes 第 " + (i + 1) + " 条：新旧译文相同，放进 approved");
  });
  (p.approved ?? []).forEach((a, i) => {
    claim("approved", a, i);
    if (!isText(a?.value) || !a.value.trim()) out.push("approved 第 " + (i + 1) + " 条：value 必须是非空字符串");
  });
  (p.doubts ?? []).forEach((d, i) => claim("doubts", d, i));
  (p.withdrawn ?? []).forEach((w, i) => {
    claim("withdrawn", w, i);
    if (!isText(w?.reason) || !w.reason.trim()) out.push("withdrawn 第 " + (i + 1) + " 条：缺少 reason");
  });
  (p.source_issues ?? []).forEach((s, i) => {
    if (!isText(s?.id) || !isText(s?.problem)) out.push("source_issues 第 " + (i + 1) + " 条：必须有 id 和 problem");
  });
  return out;
};

const commands = {
  // 列出所有语言都缺译、并且需要翻译的键：刚加的新文案。输出 [{ table, key, en }]
  "new-keys": () => {
    need("out");
    const langs = languages(),
      out = [];
    for (const [table, catalog] of Object.entries(catalogs())) {
      for (const [key, entry] of Object.entries(catalog.strings)) {
        if (entry.shouldTranslate === false) continue;
        if (langs.every((lang) => !unitsOf(entry.localizations?.[lang]).some(([u]) => u.value))) {
          out.push({ table, key, en: sourceTextAt(key, entry, []) });
        }
      }
    }
    writeOut(opt.out, JSON.stringify(out, null, 2) + "\n");
    console.log("新文案 " + out.length + " 条 → " + opt.out);
  },

  // 导出 1 种语言的待审条目
  export: () => {
    need("lang", "out");
    checkLang(opt.lang);
    if (!["needs_review", "translated", "all"].includes(opt.state)) fail("--state 只能是 needs_review、translated、all", 2);
    if (opt.table && !CATALOG_PATHS[opt.table]) fail("未知的表名: " + opt.table + "。可选: " + Object.keys(CATALOG_PATHS).join(", "), 2);
    const limit = opt.limit === undefined ? Infinity : Number(opt.limit);
    if (limit !== Infinity && !(Number.isInteger(limit) && limit > 0)) fail("--limit 必须是正整数", 2);
    let key_re = null;
    try {
      key_re = opt.key ? new RegExp(opt.key) : null;
    } catch (err) {
      fail("--key 不是合法的正则表达式：" + err.message, 2);
    }
    // --keys 是 new-keys 的输出，或键名数组
    const only = opt.keys ? new Set(readJson(opt.keys).map((k) => (typeof k === "string" ? k : k.table + "|" + k.key))) : null,
      items = [];
    for (const [table, catalog] of Object.entries(catalogs())) {
      if (opt.table && opt.table !== table) continue;
      for (const [key, entry] of Object.entries(catalog.strings)) {
        if (key_re && !key_re.test(key)) continue;
        if (only && !only.has(key) && !only.has(table + "|" + key)) continue;
        for (const [unit, path] of unitsOf(entry.localizations?.[opt.lang])) {
          if (!unit.value || (opt.state !== "all" && unit.state !== opt.state)) continue;
          items.push({
            id: idOf(table, key, path),
            en: sourceTextAt(key, entry, path),
            comment: entry.comment ?? "",
            current: unit.value,
            state: unit.state,
          });
        }
      }
    }
    const limited = items.slice(0, limit);
    writeOut(opt.out, JSON.stringify({ lang: opt.lang, items: limited }, null, 2) + "\n");
    console.log("导出 " + limited.length + " 条" + (limited.length < items.length ? "（共 " + items.length + " 条）" : "") + " → " + opt.out);
  },

  // 写回审校结果：changes 改译文，approved 确认原译文；全部状态设为 translated
  // 先校验结构，再逐条核对原值，并按 check.js 的规则（含例外清单）校验新译文；任何 1 条不合格时不写入任何条目
  apply: () => {
    need("lang", "proposal");
    checkLang(opt.lang);
    const proposal = readJson(opt.proposal),
      shape = proposalProblemsOf(proposal);
    if (shape.length) fail("proposal 格式不对，没有写入任何条目：\n" + shape.join("\n"), 2);
    if (proposal.lang !== opt.lang) fail("proposal 的语言是 " + proposal.lang + "，不是 " + opt.lang);
    const exceptions_path = join(root, "i18n/check-exceptions.json"),
      exception_li = existsSync(exceptions_path) ? readJson(exceptions_path) : [],
      exception_problems = exceptionProblemsOf(exception_li);
    if (exception_problems.length) fail("i18n/check-exceptions.json 格式错误：\n" + exception_problems.join("\n"), 2);
    const cats = catalogs(),
      exceptions = exceptionMatcherOf(exception_li),
      problems = [],
      plan = [];
    const locate = (id) => {
      const p = parseId(id),
        entry = p && cats[p.table]?.strings[p.key],
        unit = entry && unitAt(entry.localizations?.[opt.lang], p.path);
      return unit ? { ...p, entry, unit } : null;
    };
    for (const c of proposal.changes ?? []) {
      const hit = locate(c.id);
      if (!hit) problems.push(c.id + "：catalog 中没有这条译文");
      else if (hit.unit.value !== c.old) problems.push(c.id + "：原译文已变化，当前是 " + JSON.stringify(hit.unit.value));
      else {
        const source = unitSourceOf(opt.lang, hit.key, hit.entry, hit.path, c.new),
          issues = unitIssuesOf(opt.lang, source, c.new).filter((i) => !exceptions.skip(hit.table, hit.key, opt.lang, i.rule));
        if (issues.length) problems.push(c.id + "：新译文不合格：" + issues.map((i) => i.msg).join("；"));
        else plan.push({ table: hit.table, unit: hit.unit, value: c.new });
      }
    }
    for (const a of proposal.approved ?? []) {
      const hit = locate(a.id);
      if (!hit) problems.push(a.id + "：catalog 中没有这条译文");
      else if (hit.unit.value !== a.value) problems.push(a.id + "：原译文已变化，当前是 " + JSON.stringify(hit.unit.value));
      else plan.push({ table: hit.table, unit: hit.unit, value: a.value });
    }
    if (problems.length) fail("没有写入任何条目：\n" + problems.join("\n"));
    if (opt["dry-run"]) return console.log("检查通过，可以写入 " + plan.length + " 条");
    for (const { unit, value } of plan) {
      unit.value = value;
      unit.state = "translated";
    }
    // 只写有改动的 catalog
    for (const table of new Set(plan.map((p) => p.table))) writeCatalog(join(root, CATALOG_PATHS[table]), cats[table]);
    console.log("写入 " + plan.length + " 条，状态改为 translated");
  },

  // 回译输入：改过的条目用新译文，确认的条目用原译文；id 换成不透明 id，映射写进同目录的 back-ids.json
  // --ids-file 只输出指定条目（用于再次回译），可以直接用比对代理的输出
  "back-input": () => {
    need("proposal", "out");
    const proposal = readJson(opt.proposal),
      shape = proposalProblemsOf(proposal);
    if (shape.length) fail("proposal 格式不对：\n" + shape.join("\n"), 2);
    let only = null;
    if (opt["ids-file"]) {
      const list = readJson(opt["ids-file"]);
      if (!Array.isArray(list)) fail("--ids-file 必须是数组", 2);
      // 比对代理输出的 id 是 <lang>|<条目 id>
      only = new Set(list.map((x) => (typeof x === "string" ? x : x?.id)).map((id) => (id?.startsWith(proposal.lang + "|") ? id.slice(proposal.lang.length + 1) : id)));
    }
    const current = currentTextOf(proposal),
      items = [...current].filter(([id]) => !only || only.has(id)).map(([id, text]) => ({ id, text }));
    if (only) {
      const unmatched = [...only].filter((id) => !current.has(id));
      if (unmatched.length) console.log("警告：--ids-file 中 " + unmatched.length + " 条不在 proposal 的 changes 或 approved 中：\n  " + unmatched.join("\n  "));
      if (!items.length) fail("--ids-file 没有匹配到任何条目，检查 id 和语言前缀");
    }
    // 映射放在 proposal 所在的语言目录：compare-input 和 report 从这里读，--out 指向别的目录时也能找到
    const ids_path = join(dirname(opt.proposal), BACK_IDS),
      ids = existsSync(ids_path) ? readJson(ids_path) : {};
    for (const it of items) ids[backIdOf(it.id, it.text)] = { id: it.id, text: it.text };
    writeOut(opt.out, JSON.stringify(items.map((it) => ({ id: backIdOf(it.id, it.text), text: it.text })), null, 2) + "\n");
    writeOut(ids_path, JSON.stringify(ids, null, 2) + "\n");
    console.log("回译输入 " + items.length + " 条 → " + opt.out);
  },

  // 比对输入：合并多种语言的英文与最新一轮回译，id 写成 <lang>|<条目 id>；没有导出或 proposal 的语言跳过
  "compare-input": () => {
    need("dir", "langs", "out");
    const items = opt.langs.split(",").flatMap((lang) => {
      const dir = join(opt.dir, lang);
      if (!existsSync(join(dir, "export.json"))) {
        console.log(lang + "：没有 export.json，跳过");
        return [];
      }
      if (!existsSync(join(dir, "proposal.json"))) {
        console.log(lang + "：没有 proposal.json，跳过");
        return [];
      }
      // 只比对 proposal 当前的条目，并且回译必须对应当前译文；过期或缺少回译的条目提示重新回译
      const en = new Map(readJson(join(dir, "export.json")).items.map((it) => [it.id, it.en])),
        warnings = [],
        back = latestBackOf(dir, warnings),
        out = [];
      for (const [id, text] of currentTextOf(readJson(join(dir, "proposal.json")))) {
        const b = back.get(id);
        if (!b) warnings.push("缺少回译：" + id);
        else if (b.text !== text) warnings.push("回译已过期（译文改过）：" + id);
        else out.push({ id: lang + "|" + id, en: en.get(id) ?? "", back: b.back, note: b.note });
      }
      if (warnings.length) console.log(lang + "：" + warnings.length + " 个问题，先重新回译：\n  " + warnings.join("\n  "));
      return out;
    });
    writeOut(opt.out, JSON.stringify(items, null, 2) + "\n");
    console.log("比对输入 " + items.length + " 条 → " + opt.out);
  },

  // 审校报告：读 <dir>/<lang>/ 下的 export.json、proposal.json、back*.json，以及 <dir>/compare.json（比对代理的输出）
  report: () => {
    need("dir", "langs", "out");
    const compare_path = join(opt.dir, "compare.json");
    if (!existsSync(compare_path)) console.log("警告：没有 " + compare_path + "，报告中「回译不一致」一节为空。比对结果没有问题时也要写 []");
    const compare = existsSync(compare_path) ? readJson(compare_path) : [],
      data = opt.langs.split(",").flatMap((lang) => {
        const dir = join(opt.dir, lang);
        if (!existsSync(join(dir, "proposal.json"))) {
          console.log(lang + "：没有 proposal.json，报告中不列这种语言");
          return [];
        }
        const exported = new Map((existsSync(join(dir, "export.json")) ? readJson(join(dir, "export.json")).items : []).map((it) => [it.id, it])),
          proposal = readJson(join(dir, "proposal.json")),
          back = latestBackOf(dir),
          en = (id) => exported.get(id)?.en ?? "";
        // 回译对应的译文和当前译文不同时，标为过期
        const backOf = (id, text) => {
          const b = back.get(id);
          if (!b) return { back: "", note: "" };
          return b.text === text ? { back: b.back, note: b.note } : { back: b.back, note: "回译已过期：译文在回译后改过" };
        };
        const row = (id, text, extra) => ({ id, en: en(id), ...backOf(id, text), ...extra });
        const handled = new Set(["changes", "approved", "doubts", "withdrawn"].flatMap((k) => (proposal[k] ?? []).map((x) => x.id)));
        return [
          {
            lang,
            changes: (proposal.changes ?? []).map((c) => row(c.id, c.new, { old: c.old, new: c.new, type: c.type, reason: c.reason ?? "" })),
            approved: (proposal.approved ?? []).map((a) => row(a.id, a.value, { value: a.value })),
            doubts: (proposal.doubts ?? []).map((d) => ({ ...d, en: en(d.id) })),
            source_issues: proposal.source_issues ?? [],
            withdrawn: (proposal.withdrawn ?? []).map((w) => ({ ...w, en: en(w.id), current: exported.get(w.id)?.current ?? "" })),
            // 导出了但 proposal 中哪个列表都没有的条目：没有处理，保持原状态
            unhandled: [...exported.values()].filter((it) => !handled.has(it.id)).map((it) => ({ id: it.id, en: it.en, current: it.current })),
            mismatches: compare
              .filter((m) => typeof m?.id === "string" && m.id.startsWith(lang + "|"))
              .map((m) => ({ ...m, id: m.id.slice(lang.length + 1), en: en(m.id.slice(lang.length + 1)) })),
          },
        ];
      });
    writeOut(opt.out, reportHtmlOf(data));
    console.log("审校报告 → " + opt.out);
  },
};

if (!commands[cmd]) fail(USAGE, 2);
commands[cmd]();
