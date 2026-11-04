#!/usr/bin/env bun
// 机翻缺译条目，写入的译文状态是 needs_review；已有译文一律不动
// 用法：bun scripts/i18n/translate.js [--lang ja,zh-HK] [--dry-run] [--limit 20] [--verbose]
// token：环境变量 WEBC_TOKEN，或 ~/.config/webc.site.yml

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CATALOG_PATHS, readCatalog, writeCatalog } from "./lib/catalog.js";
import { langIdOf, tokenOf, transportOf } from "./lib/api.js";
import { derivableCountOf, deriveLang, pendingOf, translateLang } from "./lib/translate.js";

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
  limit = opt.limit === undefined ? Infinity : Number(opt.limit);
// 配置错误时立即退出：每种语言必须有且只有 api 或 derive 中的 1 项，api 必须是接口支持的代码
const config_problems = config.flatMap((l) => {
  if (!!l.api === !!l.derive) return [l.code + "：必须有且只有 api 或 derive 中的 1 项"];
  if (l.api) {
    try {
      langIdOf(l.api);
    } catch (err) {
      return [l.code + "：" + err.message];
    }
    return [];
  }
  const base = config.find((x) => x.code === l.derive.from);
  if (!base?.api) return [l.code + "：derive.from 必须是用接口翻译的已启用语言"];
  return /^[a-z]+-[a-z]+$/.test(l.derive.opencc ?? "") ? [] : [l.code + "：derive.opencc 必须写成 <from>-<to>，例如 tw-hk"];
});
if (config_problems.length) {
  console.error("i18n/languages.json 配置错误：\n" + config_problems.join("\n"));
  process.exit(2);
}
if (unknown.length || !(Number.isInteger(limit) || limit === Infinity) || limit <= 0) {
  console.error(unknown.length ? "未知语言: " + unknown.join(", ") : "--limit 必须是正整数");
  process.exit(2);
}

// 先翻译接口支持的语言，再生成派生语言（zh-HK 依赖 zh-Hant 的结果）
const targets = config.filter((l) => wanted.includes(l.code)).sort((a, b) => Number(!!a.derive) - Number(!!b.derive)),
  paths = Object.fromEntries(Object.entries(CATALOG_PATHS).map(([t, p]) => [t, join(root, p)])),
  // 先取修改时间再读文件：两步之间被修改时，保存前的比较能发现
  mtimes = Object.fromEntries(Object.entries(paths).map(([t, p]) => [t, statSync(p).mtimeMs])),
  catalogs = Object.fromEntries(Object.entries(paths).map(([t, p]) => [t, readCatalog(p)])),
  // 一次运行可能持续数十分钟；期间 catalog 被其他工具改过时中止，不覆盖别人的改动
  save = () => {
    const changed = Object.entries(paths).filter(([t, p]) => statSync(p).mtimeMs !== mtimes[t]);
    if (changed.length) throw new Error("catalog 在翻译期间被修改，没有写入: " + changed.map(([, p]) => p).join(", "));
    for (const [t, p] of Object.entries(paths)) {
      writeCatalog(p, catalogs[t]);
      mtimes[t] = statSync(p).mtimeMs;
    }
  };

if (opt["dry-run"]) {
  for (const l of targets) {
    if (l.derive) {
      console.log(l.code + "：现在可由 " + l.derive.from + " 转换 " + derivableCountOf(catalogs, l.code, l.derive) + " 条（先翻译 " + l.derive.from + " 后会更多）");
      continue;
    }
    const skipped = [],
      { units, copies } = pendingOf(catalogs, l.code, skipped);
    console.log(l.code + "：待翻译 " + units.length + " 条" + (copies.length ? "，复制复数类别 " + copies.length + " 条" : "") + (skipped.length ? "，不支持 " + skipped.length + " 条" : ""));
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
  let report;
  try {
    report = l.derive
      ? deriveLang({ catalogs, lang: l.code, derive: l.derive })
      : await translateLang({ catalogs, lang: l.code, api_lang: l.api, transport, limit });
    save();
  } catch (err) {
    // 致命错误（例如 token 无效）或 catalog 被并发修改：已完成的语言已经写回
    console.error(l.code + "：中止。" + err.message);
    process.exit(1);
  }
  failed_n += report.failed.length;
  console.log(
    l.code + "：写入 " + report.written + " 条" + (report.failed.length ? "，失败 " + report.failed.length + " 条" : "") + (report.skipped.length ? "，不支持 " + report.skipped.length + " 条" : ""),
  );
  const shown = opt.verbose ? [...report.failed, ...report.skipped] : report.failed.slice(0, 10);
  for (const f of shown) console.log("  " + (f.table ? f.table + " " + JSON.stringify(f.key) + "：" : "") + f.reason);
  if (!opt.verbose && report.failed.length > shown.length) console.log("  ……另有 " + (report.failed.length - shown.length) + " 条，加 --verbose 查看");
}
if (failed_n) console.log("失败的条目保持缺译，运行时显示英文。可以重新运行，或人工翻译后写入 catalog。");
