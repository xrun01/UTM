#!/usr/bin/env bun
// 审校辅助：导出待审条目、写回审校结果、生成回译与比对输入、生成审校报告
// 用法见 .agents/skills/utm-i18n/SKILL.md 的「流程 3：审校」

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CATALOG_PATHS, readCatalog, setUnit, unitAt, unitsOf, writeCatalog } from "./lib/catalog.js";
import { exceptionMatcherOf, exceptionProblemsOf, missingPathsOf, sourceTextAt, unitIssuesOf, unitSourceOf } from "./lib/checks.js";
import { reportHtmlOf } from "./lib/report.js";

const USAGE = `用法：
  review.js new-keys --out <file>
  review.js export --lang <code> --out <file> [--state needs_review|translated|all|missing] [--table <表名>] [--key <正则>] [--keys <file>] [--limit <n>]
  review.js apply --lang <code> --proposal <file> [--export <file>] [--dry-run]
  review.js back-input --proposal <file> --out <file> [--ids-file <file>]
  review.js compare-input --dir <目录> --langs <code,code> --out <file>
  review.js report --dir <目录> --langs <code,code> --out <file>`;

// 改稿代理只修这 5 类问题；缺译条目（导出状态是 missing）的改动类型是「补译」
const FIX_TYPES = ["语义错误", "术语错误", "漏译", "文字系统错误", "不通顺"],
  FILL_TYPE = "补译",
  CHANGE_TYPES = [...FIX_TYPES, FILL_TYPE],
  // proposal 中记录条目的 4 个列表：同一条目只能出现在其中 1 个
  ID_LISTS = ["changes", "approved", "doubts", "withdrawn"];

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
      export: { type: "string" },
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

// 校验 proposal 的结构；返回问题描述列表
const proposalProblemsOf = (p) => {
  const out = [],
    seen = new Map(),
    isText = (v) => typeof v === "string";
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["proposal 必须是对象"];
  if (!isText(p.lang)) out.push("缺少 lang");
  for (const name of [...ID_LISTS, "source_issues"]) {
    if (p[name] !== undefined && !Array.isArray(p[name])) out.push(name + " 必须是数组");
  }
  if (out.length) return out;
  const claim = (list, item, i) => {
    const parsed = parseId(item?.id);
    if (!parsed) return out.push(list + " 第 " + (i + 1) + " 条：id 格式不对");
    // 表名必须存在：带语言前缀的 id（例如比对代理输出的 de|Localizable|…）会绕过重复检查
    if (!CATALOG_PATHS[parsed.table]) return out.push(list + " 第 " + (i + 1) + " 条：id 的表名不对：" + item.id);
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

// 读取并校验输入文件；格式不对时退出码 2
const proposalAt = (path) => {
  const p = readJson(path),
    shape = proposalProblemsOf(p);
  if (shape.length) fail(path + " 格式不对：\n" + shape.join("\n"), 2);
  return p;
};
const exportAt = (path) => {
  const e = readJson(path);
  if (typeof e?.lang !== "string" || !Array.isArray(e.items) || !e.items.every((it) => typeof it?.id === "string")) {
    fail(path + " 格式不对：必须是 export 的输出 { lang, items: [{ id, … }] }", 2);
  }
  return e;
};
const arrayAt = (path) => {
  const v = readJson(path);
  if (!Array.isArray(v)) fail(path + " 必须是 JSON 数组", 2);
  return v;
};

// proposal 当前要写入的条目：Map<条目 id, 译文>
const currentTextOf = (proposal) =>
  new Map([...(proposal.changes ?? []).map((c) => [c.id, c.new]), ...(proposal.approved ?? []).map((a) => [a.id, a.value])]);

// 回译用的不透明编号：由条目 id 和送去回译的译文算出。条目 id 里有英文原文，回译代理看到就失去了检查作用
// 译文改过以后编号随之改变，旧回译自然不再对应；改回早一轮的译文时，那一轮的回译仍然有效
const backIdOf = (id, text) => "b" + createHash("sha1").update(id + "\x00" + text).digest("hex").slice(0, 10);
const BACK_FILE_RE = /^back\d*\.json$/,
  roundOf = (file) => parseInt(file.slice(4)) || 1;

// <dir> 下全部回译：Map<不透明编号, { back, note }>。按 back.json、back2.json……的轮次读，同一编号以后一轮为准
const backsOf = (dir) => {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => BACK_FILE_RE.test(f)).sort((a, b) => roundOf(a) - roundOf(b)) : [],
    out = new Map();
  for (const f of files) {
    for (const b of arrayAt(join(dir, f))) {
      if (typeof b?.id === "string") out.set(b.id, { back: String(b.back ?? ""), note: String(b.note ?? "") });
    }
  }
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

  // 导出 1 种语言的待审条目。--state missing 导出缺译条目（例如机翻失败的），current 是空串
  export: () => {
    need("lang", "out");
    checkLang(opt.lang);
    if (!["needs_review", "translated", "all", "missing"].includes(opt.state)) fail("--state 只能是 needs_review、translated、all、missing", 2);
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
    const only = opt.keys ? new Set(arrayAt(opt.keys).map((k) => (typeof k === "string" ? k : k?.table + "|" + k?.key))) : null,
      items = [];
    for (const [table, catalog] of Object.entries(catalogs())) {
      if (opt.table && opt.table !== table) continue;
      for (const [key, entry] of Object.entries(catalog.strings)) {
        if (key_re && !key_re.test(key)) continue;
        if (only && !only.has(key) && !only.has(table + "|" + key)) continue;
        const item = (path, current, state) => ({
          id: idOf(table, key, path),
          en: sourceTextAt(key, entry, path),
          comment: entry.comment ?? "",
          current,
          state,
        });
        if (opt.state === "missing") {
          for (const path of missingPathsOf(opt.lang, key, entry)) items.push(item(path, "", "missing"));
          continue;
        }
        for (const [unit, path] of unitsOf(entry.localizations?.[opt.lang])) {
          if (unit.value && (opt.state === "all" || unit.state === opt.state)) items.push(item(path, unit.value, unit.state));
        }
      }
    }
    const limited = items.slice(0, limit);
    writeOut(opt.out, JSON.stringify({ lang: opt.lang, items: limited }, null, 2) + "\n");
    console.log("导出 " + limited.length + " 条" + (limited.length < items.length ? "（共 " + items.length + " 条）" : "") + " → " + opt.out);
  },

  // 写回审校结果：changes 写入新译文，approved 确认原译文；写入的条目状态都改为 translated
  // 只写导出过的条目，并逐条核对导出后没有变化（译文、状态、英文），所以不会覆盖导出后别人确认或改过的译文
  // 已经写入的条目跳过，可以重复运行。任何 1 条不合格时不写入任何条目
  apply: () => {
    need("lang", "proposal");
    checkLang(opt.lang);
    const proposal = proposalAt(opt.proposal);
    if (proposal.lang !== opt.lang) fail("proposal 的语言是 " + proposal.lang + "，不是 " + opt.lang);
    const export_path = opt.export ?? join(dirname(opt.proposal), "export.json");
    if (!existsSync(export_path)) fail("没有 " + export_path + "。apply 按导出时的状态核对每一条，先运行 export，或用 --export 指定", 2);
    const exp = exportAt(export_path);
    if (exp.lang !== opt.lang) fail(export_path + " 的语言是 " + exp.lang + "，不是 " + opt.lang);
    const exceptions_path = join(root, "i18n/check-exceptions.json"),
      exception_li = existsSync(exceptions_path) ? readJson(exceptions_path) : [],
      exception_problems = exceptionProblemsOf(exception_li);
    if (exception_problems.length) fail("i18n/check-exceptions.json 格式错误：\n" + exception_problems.join("\n"), 2);

    const exported = new Map(exp.items.map((it) => [it.id, it])),
      handled = new Set(ID_LISTS.flatMap((k) => (proposal[k] ?? []).map((x) => x.id))),
      cats = catalogs(),
      exceptions = exceptionMatcherOf(exception_li),
      problems = exp.items.filter((it) => !handled.has(it.id)).map((it) => it.id + "：导出了，但 proposal 没有处理。放进 changes、approved、doubts 或 withdrawn"),
      plan = [];
    let done = 0;
    const targets = [
      ...(proposal.changes ?? []).map((c) => ({ id: c.id, value: c.new, before: c.old, type: c.type, field: "old" })),
      ...(proposal.approved ?? []).map((a) => ({ id: a.id, value: a.value, before: a.value, field: "value" })),
    ];
    for (const t of targets) {
      const ex = exported.get(t.id),
        p = parseId(t.id),
        entry = cats[p.table].strings[p.key],
        unit = entry && unitAt(entry.localizations?.[opt.lang], p.path),
        bad = (msg) => problems.push(t.id + "：" + msg);
      if (!ex) bad("不在导出结果中。只能写入导出过的条目");
      else if (t.before !== ex.current) bad(t.field + " 与导出时的译文不同，导出时是 " + JSON.stringify(ex.current));
      else if ((ex.state === "missing") !== (t.type === FILL_TYPE)) bad(ex.state === "missing" ? "缺译条目只能放进 changes，type 是「" + FILL_TYPE + "」" : "只有缺译条目的 type 是「" + FILL_TYPE + "」");
      else if (!entry) bad("catalog 中已经没有这个键");
      else if (unit?.value === t.value && unit.state === "translated") done++;
      else if ((unit?.value ?? "") !== ex.current || (unit?.value ? unit.state : "missing") !== ex.state) {
        bad("导出后译文或状态变了，现在是 " + (unit?.value ? unit.state + " " + JSON.stringify(unit.value) : "缺译") + "。重新导出再审");
      } else if (sourceTextAt(p.key, entry, p.path) !== ex.en) bad("导出后英文变了。重新导出再审");
      else {
        const source = unitSourceOf(opt.lang, p.key, entry, p.path, t.value),
          issues = unitIssuesOf(opt.lang, source, t.value).filter((i) => !exceptions.skip(p.table, p.key, opt.lang, i.rule));
        if (issues.length) bad("译文不合格：" + issues.map((i) => i.msg).join("；"));
        else plan.push({ ...p, unit, value: t.value });
      }
    }
    if (problems.length) fail("没有写入任何条目：\n" + problems.join("\n"));
    const skipped = done ? "，已经写入过的 " + done + " 条跳过" : "";
    if (opt["dry-run"]) return console.log("检查通过，可以写入 " + plan.length + " 条" + skipped);
    for (const { table, key, path, unit, value } of plan) {
      if (unit) Object.assign(unit, { state: "translated", value });
      else setUnit(cats[table], key, opt.lang, path, value, "translated");
    }
    // 只写有改动的 catalog
    for (const table of new Set(plan.map((p) => p.table))) writeCatalog(join(root, CATALOG_PATHS[table]), cats[table]);
    console.log("写入 " + plan.length + " 条，状态改为 translated" + skipped);
  },

  // 回译输入：proposal 中还没有当前译文回译的条目（改过的条目自动包括在内），id 换成不透明编号
  // --ids-file 只输出指定的条目，即使已有回译（用于换 1 个回译代理复核）；可以直接用比对代理的输出
  "back-input": () => {
    need("proposal", "out");
    const proposal = proposalAt(opt.proposal),
      current = currentTextOf(proposal),
      backs = backsOf(dirname(opt.proposal));
    let items;
    if (opt["ids-file"]) {
      // 比对代理输出的 id 是 <lang>|<条目 id>
      const only = new Set(
        arrayAt(opt["ids-file"])
          .map((x) => (typeof x === "string" ? x : x?.id))
          .map((id) => (id?.startsWith(proposal.lang + "|") ? id.slice(proposal.lang.length + 1) : id)),
      );
      const unmatched = [...only].filter((id) => !current.has(id));
      if (unmatched.length) console.log("警告：--ids-file 中 " + unmatched.length + " 条不在 proposal 的 changes 或 approved 中：\n  " + unmatched.join("\n  "));
      items = [...current].filter(([id]) => only.has(id));
      if (!items.length) fail("--ids-file 没有匹配到任何条目，检查 id 和语言前缀");
    } else items = [...current].filter(([id, text]) => !backs.has(backIdOf(id, text)));
    writeOut(opt.out, JSON.stringify(items.map(([id, text]) => ({ id: backIdOf(id, text), text })), null, 2) + "\n");
    console.log(items.length ? "回译输入 " + items.length + " 条 → " + opt.out : "所有条目都已有当前译文的回译，不用再回译");
  },

  // 比对输入：合并多种语言的英文与当前译文的回译，id 写成 <lang>|<条目 id>；没有 export 或 proposal 的语言跳过
  "compare-input": () => {
    need("dir", "langs", "out");
    const items = opt.langs.split(",").flatMap((lang) => {
      const dir = join(opt.dir, lang);
      for (const f of ["export.json", "proposal.json"]) {
        if (!existsSync(join(dir, f))) {
          console.log(lang + "：没有 " + f + "，跳过");
          return [];
        }
      }
      const exported = new Map(exportAt(join(dir, "export.json")).items.map((it) => [it.id, it])),
        backs = backsOf(dir),
        warnings = [],
        out = [];
      for (const [id, text] of currentTextOf(proposalAt(join(dir, "proposal.json")))) {
        const b = backs.get(backIdOf(id, text));
        if (!exported.has(id)) warnings.push("不在 export.json 中：" + id);
        else if (!b) warnings.push("缺少当前译文的回译：" + id);
        else out.push({ id: lang + "|" + id, en: exported.get(id).en, back: b.back, note: b.note });
      }
      if (warnings.length) console.log(lang + "：" + warnings.length + " 条没有放进比对输入，先运行 back-input 补回译：\n  " + warnings.join("\n  "));
      return out;
    });
    writeOut(opt.out, JSON.stringify(items, null, 2) + "\n");
    console.log("比对输入 " + items.length + " 条 → " + opt.out);
  },

  // 审校报告：读 <dir>/<lang>/ 下的 export.json、proposal.json、back*.json，以及 <dir>/compare.json（比对代理的输出）
  report: () => {
    need("dir", "langs", "out");
    const langs = opt.langs.split(","),
      compare_path = join(opt.dir, "compare.json");
    if (!existsSync(compare_path)) console.log("警告：没有 " + compare_path + "，报告中「回译不一致」一节为空。比对没有发现问题时也要写 []");
    else {
      // 比对结果早于最新的回译时，后来改过的条目没有比对过
      const compared_at = statSync(compare_path).mtimeMs,
        newer = langs.flatMap((lang) => {
          const dir = join(opt.dir, lang);
          return existsSync(dir) ? readdirSync(dir).filter((f) => BACK_FILE_RE.test(f) && statSync(join(dir, f)).mtimeMs > compared_at).map((f) => lang + "/" + f) : [];
        });
      if (newer.length) console.log("警告：" + newer.join("、") + " 比 compare.json 新。重新运行 compare-input 和比对代理，覆盖 compare.json");
    }
    const compare = existsSync(compare_path) ? arrayAt(compare_path) : [],
      data = langs.flatMap((lang) => {
        const dir = join(opt.dir, lang);
        if (!existsSync(join(dir, "proposal.json"))) {
          console.log(lang + "：没有 proposal.json，报告中不列这种语言");
          return [];
        }
        const exported = new Map((existsSync(join(dir, "export.json")) ? exportAt(join(dir, "export.json")).items : []).map((it) => [it.id, it])),
          proposal = proposalAt(join(dir, "proposal.json")),
          backs = backsOf(dir),
          en = (id) => exported.get(id)?.en ?? "",
          // 只取当前译文的回译；没有时 back 为空，报告中显示「没有回译」
          row = (id, text, extra) => ({ id, en: en(id), back: "", note: "", ...backs.get(backIdOf(id, text)), ...extra }),
          changes = (proposal.changes ?? []).map((c) => row(c.id, c.new, { old: c.old, new: c.new, type: c.type, reason: c.reason ?? "" })),
          approved = (proposal.approved ?? []).map((a) => row(a.id, a.value, { value: a.value }));
        return [
          {
            lang,
            changes,
            approved,
            no_back: [...changes, ...approved].filter((x) => !x.back).length,
            doubts: (proposal.doubts ?? []).map((d) => ({ ...d, en: en(d.id) })),
            source_issues: proposal.source_issues ?? [],
            withdrawn: (proposal.withdrawn ?? []).map((w) => ({ ...w, en: en(w.id), current: exported.get(w.id)?.current ?? "" })),
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
