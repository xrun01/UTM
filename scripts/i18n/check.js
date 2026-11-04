#!/usr/bin/env bun
// 译文与源码的机械检查。退出码：0 没有错误（可以有警告），1 有错误，2 参数错误
// 用法：bun scripts/i18n/check.js [--lang ja,ko] [--verbose] [--ci]

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CATALOG_PATHS, readCatalog } from "./lib/catalog.js";
import { catalogIssuesOf, exceptionMatcherOf } from "./lib/checks.js";
import { run } from "./lib/run.js";
import { CJK_RE, stringLiteralsOf } from "./lib/scan.js";
import { syncAll } from "./lib/sync.js";

let opt;
try {
  ({ values: opt } = parseArgs({
    options: {
      root: { type: "string", default: resolve(import.meta.dirname, "../..") },
      lang: { type: "string" },
      verbose: { type: "boolean", default: false },
      ci: { type: "boolean", default: false },
      "build-dir": { type: "string" },
    },
  }));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const root = resolve(opt.root),
  known = JSON.parse(readFileSync(join(root, "i18n/languages.json"), "utf8")).languages.map((l) => l.code),
  langs = opt.lang ? opt.lang.split(",").map((s) => s.trim()) : known,
  exceptions_path = join(root, "i18n/check-exceptions.json"),
  exceptions = exceptionMatcherOf(existsSync(exceptions_path) ? JSON.parse(readFileSync(exceptions_path, "utf8")) : []);

const bad_lang = langs.filter((l) => !known.includes(l));
if (bad_lang.length) {
  console.error("未知语言: " + bad_lang.join(", ") + "。可选: " + known.join(", "));
  process.exit(2);
}

const errors = [],
  warns = [],
  missing = {};
const error = (where, msg) => errors.push("错误 " + where + " " + msg),
  warn = (where, msg) => warns.push("警告 " + where + " " + msg);

// 1. catalog 中的译文
for (const [table, rel] of Object.entries(CATALOG_PATHS)) {
  if (!existsSync(join(root, rel))) {
    error(rel, "catalog 不存在");
    continue;
  }
  const issues = catalogIssuesOf(table, readCatalog(join(root, rel)), { langs, known: new Set(known), exceptions });
  for (const i of issues) {
    const where = table + (i.lang ? " [" + i.lang + "]" : "") + " " + JSON.stringify(i.key);
    if (i.level === "error") error(where, i.msg);
    else if (i.level === "warn") warn(where, i.msg);
    else (missing[i.lang] ??= []).push(where);
  }
}

// 只检查部分语言时，其他语言的例外不会被用到，所以只在全量检查时报告无用的例外
if (!opt.lang) {
  for (const e of exceptions.unused()) error("i18n/check-exceptions.json", "例外没有命中任何问题，删除它: " + JSON.stringify(e));
}

// 2. 源码中写死的中日韩文字：界面文案必须写英文，再通过 catalog 翻译
for (const rel of run("git", "-C", root, "ls-files", "*.swift", "*.m", "*.h").trim().split("\n").filter(Boolean)) {
  const src = readFileSync(join(root, rel), "utf8");
  for (const { line, text } of stringLiteralsOf(src, { swift: rel.endsWith(".swift") })) {
    if (CJK_RE.test(text)) error(rel + ":" + line, "字符串字面量含中日韩文字，改成英文文案: " + JSON.stringify(text));
  }
}

// 3. CI：提取结果必须已经同步进 catalog
if (opt.ci) {
  try {
    const result = syncAll({ root, build_dir: opt["build-dir"] ?? join(root, "build/i18n"), write: false });
    for (const { path, before, after } of Object.values(result)) {
      if (before !== after) error(path.slice(root.length + 1), "和源码不同步，运行 bun scripts/i18n/sync.js 后提交");
    }
  } catch (err) {
    error("sync", err.message);
  }
}

for (const lang of langs) {
  const list = missing[lang] ?? [];
  if (list.length) warn("[" + lang + "]", "缺译 " + list.length + " 条" + (opt.verbose ? "：\n  " + list.join("\n  ") : "，加 --verbose 查看"));
}

for (const line of [...errors, ...warns]) console.log(line);
console.log(errors.length + " 个错误，" + warns.length + " 个警告");
process.exit(errors.length ? 1 : 0);
