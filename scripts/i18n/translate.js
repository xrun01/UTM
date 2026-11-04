#!/usr/bin/env bun
// 机翻缺译条目，写入的译文状态是 needs_review；已有译文一律不动
// 用法：bun scripts/i18n/translate.js [--lang ja,zh-HK] [--dry-run] [--limit 20] [--verbose]
// token：环境变量 WEBC_TOKEN，或 ~/.config/webc.site.yml

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CATALOG_PATHS, readCatalog, writeCatalog } from "./lib/catalog.js";
import { tokenOf, transportOf } from "./lib/api.js";
import { deriveLang, pendingOf, translateLang } from "./lib/translate.js";

let opt;
try {
  ({ values: opt } = parseArgs({
    options: {
      root: { type: "string", default: resolve(import.meta.dirname, "../..") },
      lang: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
  }));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const root = resolve(opt.root),
  config = JSON.parse(readFileSync(join(root, "i18n/languages.json"), "utf8")).languages,
  wanted = opt.lang ? opt.lang.split(",").map((s) => s.trim()) : config.map((l) => l.code),
  unknown = wanted.filter((c) => !config.some((l) => l.code === c)),
  limit = opt.limit ? Number(opt.limit) : Infinity;
if (unknown.length || !(limit > 0)) {
  console.error(unknown.length ? "未知语言: " + unknown.join(", ") : "--limit 必须是正整数");
  process.exit(2);
}

// 先翻译接口支持的语言，再生成派生语言（zh-HK 依赖 zh-Hant 的结果）
const targets = config.filter((l) => wanted.includes(l.code)).sort((a, b) => Number(!!a.derive) - Number(!!b.derive)),
  catalogs = Object.fromEntries(Object.entries(CATALOG_PATHS).map(([t, p]) => [t, readCatalog(join(root, p))])),
  save = () => {
    for (const [t, p] of Object.entries(CATALOG_PATHS)) writeCatalog(join(root, p), catalogs[t]);
  };

if (opt["dry-run"]) {
  for (const l of targets) {
    const skipped = [],
      n = pendingOf(catalogs, l.code, skipped).length;
    console.log(l.code + "：待翻译 " + n + " 条" + (skipped.length ? "，不支持 " + skipped.length + " 条" : "") + (l.derive ? "（由 " + l.derive.from + " 转换）" : ""));
  }
  process.exit(0);
}

let transport;
try {
  if (targets.some((l) => !l.derive)) transport = transportOf(tokenOf());
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let failed_n = 0;
for (const l of targets) {
  const report = l.derive
    ? deriveLang({ catalogs, lang: l.code, derive: l.derive })
    : await translateLang({ catalogs, lang: l.code, api_lang: l.api, transport, limit });
  save();
  failed_n += report.failed.length;
  console.log(
    l.code + "：写入 " + report.written + " 条" + (report.failed.length ? "，失败 " + report.failed.length + " 条" : "") + (report.skipped.length ? "，不支持 " + report.skipped.length + " 条" : ""),
  );
  const shown = opt.verbose ? [...report.failed, ...report.skipped] : report.failed.slice(0, 10);
  for (const f of shown) console.log("  " + (f.table ? f.table + " " + JSON.stringify(f.key) + "：" : "") + f.reason);
  if (!opt.verbose && report.failed.length > shown.length) console.log("  ……另有 " + (report.failed.length - shown.length) + " 条，加 --verbose 查看");
}
if (failed_n) console.log("失败的条目保持缺译，运行时显示英文。可以重新运行，或人工翻译后写入 catalog。");
