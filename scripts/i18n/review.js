#!/usr/bin/env bun
// 审校辅助：导出待审条目、写回审校结果、生成回译输入、生成审校报告
// 用法见 .agents/skills/utm-i18n/SKILL.md 的「审校」流程

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CATALOG_PATHS, readCatalog, unitAt, unitsOf, writeCatalog } from "./lib/catalog.js";
import { sourceTextAt, unitIssuesOf } from "./lib/checks.js";
import { reportHtmlOf } from "./lib/report.js";

const USAGE = `用法：
  review.js new-keys --out <file>
  review.js export --lang <code> --out <file> [--state needs_review|translated|all] [--table <表名>] [--key <正则>] [--keys <file>] [--limit <n>]
  review.js apply --lang <code> --proposal <file> [--dry-run]
  review.js back-input --proposal <file> --out <file> [--ids <id,id>]
  review.js compare-input --dir <目录> --langs <code,code> --out <file>
  review.js report --dir <目录> --langs <code,code> --out <file>`;

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
      ids: { type: "string" },
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
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const root = resolve(opt.root),
  catalogs = () => Object.fromEntries(Object.entries(CATALOG_PATHS).map(([t, p]) => [t, readCatalog(join(root, p))]));

// 条目 id：表名|键|变体路径。键本身是英文句子，所以必须带上表名和路径才唯一
const idOf = (table, key, path) => [table, key, path.join("/")].join("|");
const parseId = (id) => {
  const first = id.indexOf("|"),
    last = id.lastIndexOf("|");
  if (first < 0 || first === last) return null;
  const path = id.slice(last + 1);
  return { table: id.slice(0, first), key: id.slice(first + 1, last), path: path ? path.split("/") : [] };
};

// 合并 <dir> 下的 back.json、back2.json……；后一轮覆盖前一轮
const latestBackOf = (dir) => {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^back\d*\.json$/.test(f))
        .sort((a, b) => (parseInt(a.slice(4)) || 1) - (parseInt(b.slice(4)) || 1))
    : [];
  return new Map(files.flatMap((f) => readJson(join(dir, f)).map((b) => [b.id, b])));
};

const commands = {
  // 列出所有语言都缺译的键：刚加的新文案。输出 [{ table, key, en }]
  "new-keys": () => {
    need("out");
    const langs = JSON.parse(readFileSync(join(root, "i18n/languages.json"), "utf8")).languages.map((l) => l.code),
      out = [];
    for (const [table, catalog] of Object.entries(catalogs())) {
      for (const [key, entry] of Object.entries(catalog.strings)) {
        if (entry.shouldTranslate === false) continue;
        if (langs.every((lang) => !unitsOf(entry.localizations?.[lang]).some(([u]) => u.value))) {
          out.push({ table, key, en: sourceTextAt(key, entry, []) });
        }
      }
    }
    writeFileSync(opt.out, JSON.stringify(out, null, 2) + "\n");
    console.log("新文案 " + out.length + " 条 → " + opt.out);
  },

  // 导出 1 种语言的待审条目
  export: () => {
    need("lang", "out");
    if (!["needs_review", "translated", "all"].includes(opt.state)) fail("--state 只能是 needs_review、translated、all", 2);
    const key_re = opt.key ? new RegExp(opt.key) : null,
      // --keys 是 new-keys 的输出，或键名数组
      only = opt.keys ? new Set(readJson(opt.keys).map((k) => (typeof k === "string" ? k : k.table + "|" + k.key))) : null,
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
    const limited = opt.limit ? items.slice(0, Number(opt.limit)) : items;
    writeFileSync(opt.out, JSON.stringify({ lang: opt.lang, items: limited }, null, 2) + "\n");
    console.log("导出 " + limited.length + " 条" + (limited.length < items.length ? "（共 " + items.length + " 条）" : "") + " → " + opt.out);
  },

  // 写回审校结果：changes 改译文，approved 确认原译文；全部状态设为 translated
  // 每条都核对原值，并按 check.js 的规则校验新译文；任何 1 条不合格时不写入任何条目
  apply: () => {
    need("lang", "proposal");
    const proposal = readJson(opt.proposal),
      cats = catalogs(),
      problems = [],
      plan = [];
    if (proposal.lang !== opt.lang) fail("proposal 的语言是 " + proposal.lang + "，不是 " + opt.lang);
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
        const issues = unitIssuesOf(opt.lang, sourceTextAt(hit.key, hit.entry, hit.path), c.new);
        if (issues.length) problems.push(c.id + "：新译文不合格：" + issues.map((i) => i.msg).join("；"));
        else plan.push([hit.unit, c.new]);
      }
    }
    for (const a of proposal.approved ?? []) {
      const hit = locate(a.id);
      if (!hit) problems.push(a.id + "：catalog 中没有这条译文");
      else if (hit.unit.value !== a.value) problems.push(a.id + "：原译文已变化，当前是 " + JSON.stringify(hit.unit.value));
      else plan.push([hit.unit, a.value]);
    }
    if (problems.length) fail("没有写入任何条目：\n" + problems.join("\n"));
    if (opt["dry-run"]) return console.log("检查通过，可以写入 " + plan.length + " 条");
    for (const [unit, value] of plan) {
      unit.value = value;
      unit.state = "translated";
    }
    for (const [t, p] of Object.entries(CATALOG_PATHS)) writeCatalog(join(root, p), cats[t]);
    console.log("写入 " + plan.length + " 条，状态改为 translated");
  },

  // 回译输入：改过的条目用新译文，确认的条目用原译文；--ids 只输出指定条目（用于再次回译）
  "back-input": () => {
    need("proposal", "out");
    const proposal = readJson(opt.proposal),
      only = opt.ids ? new Set(opt.ids.split(",")) : null,
      items = [
        ...(proposal.changes ?? []).map((c) => ({ id: c.id, text: c.new })),
        ...(proposal.approved ?? []).map((a) => ({ id: a.id, text: a.value })),
      ].filter((it) => !only || only.has(it.id));
    writeFileSync(opt.out, JSON.stringify(items, null, 2) + "\n");
    console.log("回译输入 " + items.length + " 条 → " + opt.out);
  },

  // 比对输入：合并多种语言的英文与最新一轮回译，id 写成 <lang>|<条目 id>
  "compare-input": () => {
    need("dir", "langs", "out");
    const items = opt.langs.split(",").flatMap((lang) => {
      const dir = join(opt.dir, lang),
        en = new Map(readJson(join(dir, "export.json")).items.map((it) => [it.id, it.en])),
        back = latestBackOf(dir);
      return [...back.values()].map((b) => ({ id: lang + "|" + b.id, en: en.get(b.id) ?? "", back: b.back, note: b.note ?? "" }));
    });
    writeFileSync(opt.out, JSON.stringify(items, null, 2) + "\n");
    console.log("比对输入 " + items.length + " 条 → " + opt.out);
  },

  // 审校报告：读 <dir>/<lang>/ 下的 export.json、proposal.json、back*.json
  report: () => {
    need("dir", "langs", "out");
    const data = opt.langs.split(",").map((lang) => {
      const dir = join(opt.dir, lang),
        exported = new Map(readJson(join(dir, "export.json")).items.map((it) => [it.id, it])),
        proposal = readJson(join(dir, "proposal.json")),
        back = latestBackOf(dir);
      const row = (id, extra) => ({ id, en: exported.get(id)?.en ?? "", back: back.get(id)?.back ?? "", note: back.get(id)?.note ?? "", ...extra });
      return {
        lang,
        changes: (proposal.changes ?? []).map((c) => row(c.id, { old: c.old, new: c.new, type: c.type, reason: c.reason })),
        approved: (proposal.approved ?? []).map((a) => row(a.id, { value: a.value })),
        doubts: proposal.doubts ?? [],
        source_issues: proposal.source_issues ?? [],
      };
    });
    writeFileSync(opt.out, reportHtmlOf(data));
    console.log("审校报告 → " + opt.out);
  },
};

if (!commands[cmd]) fail(USAGE, 2);
commands[cmd]();
