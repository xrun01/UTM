// 把源码中的文案同步进 3 个 catalog
// Localizable 用 xcstringstool sync；InfoPlist 与 xib 没有 stringsdata，按相同规则自行同步

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CATALOG_PATHS, SOURCE_LANG, readCatalog, serializeCatalog, sourceLocOf, unitsOf } from "./catalog.js";
import { infoPlistEntriesOf, xibEntriesOf } from "./extract.js";
import { runFull } from "./run.js";

export const REMOVED_PATH = "i18n/removed.json";

const REBUILD_HINT = "先运行 bun vm/script/buildApp.js 重新构建，再运行 sync";

// 检查构建输出的 stringsdata 覆盖了工作区的全部源文件，并且没有过期；返回全部 stringsdata 路径
// 构建不完整时 xcstringstool sync 会把正常的键标为 stale，进而被删除，所以这里必须严格
export const stringsdataOf = (root, build_dir) => {
  const manifest_path = join(build_dir, "manifest.json");
  if (!existsSync(manifest_path)) throw new Error("没有找到 " + manifest_path + "。" + REBUILD_HINT);
  const manifest = JSON.parse(readFileSync(manifest_path, "utf8")),
    out = [],
    problems = [];
  if (typeof manifest.root !== "string" || typeof manifest.started_at !== "number") {
    throw new Error("构建清单缺少 root 或 started_at，vm 的构建脚本版本过旧。" + REBUILD_HINT);
  }
  // 指向另一个 checkout 的构建输出时，文件清单可能碰巧一致，但内容不同
  if (!existsSync(manifest.root) || realpathSync(manifest.root) !== realpathSync(root)) {
    throw new Error("构建输出来自另一个目录 " + manifest.root + "，不是 " + root + "。" + REBUILD_HINT);
  }

  for (const [list, ext, outputs] of [
    [manifest.swift, ".swift", (name) => [join("swiftc", name + ".stringsdata"), join("extract", name + "-swift.stringsdata")]],
    [manifest.objc, ".m", (name) => [join("extract", name + "-m.stringsdata")]],
  ]) {
    const listed = new Set(list);
    // 清单所在目录中新增的源文件，说明构建早于这次修改
    for (const dir of new Set(list.map(dirname))) {
      for (const name of readdirSync(join(root, dir))) {
        const rel = join(dir, name);
        if (name.endsWith(ext) && !listed.has(rel)) problems.push("新增的源文件不在构建清单中: " + rel);
      }
    }
    for (const rel of list) {
      const src = join(root, rel);
      if (!existsSync(src)) {
        problems.push("构建清单中的源文件已删除: " + rel);
        continue;
      }
      // 和构建开始时间比较：编译期间修改的文件，stringsdata 比它新，但内容是旧的
      if (statSync(src).mtimeMs > manifest.started_at) problems.push("源文件在构建开始后被修改: " + rel);
      for (const sd_rel of outputs(basename(rel, ext))) {
        const sd = join(build_dir, "stringsdata", sd_rel);
        if (existsSync(sd)) out.push(sd);
        else problems.push("缺少 stringsdata: " + sd_rel);
      }
    }
  }
  if (problems.length) throw new Error(problems.join("\n") + "\n" + REBUILD_HINT);
  return out;
};

// 按 xcstringstool 对「带默认值的提取键」的规则同步：
// - 新键加入；源码注释为空时保留旧注释
// - 开发者在 catalog 中改过英文（状态是 translated，或有复数变体）时保留英文，键改为手动维护
// - 英文变化时更新英文，并把这个键的全部已有译文改为 needs_review
// - 源码中消失的键标为 stale（手动维护的键除外）
export const syncEntries = (catalog, entries) => {
  const stats = { added: 0, changed: 0 };
  for (const [key, { value, comment }] of entries) {
    const entry = catalog.strings[key];
    if (!entry) {
      catalog.strings[key] = {
        ...(comment ? { comment } : {}),
        extractionState: "extracted_with_value",
        localizations: { [SOURCE_LANG]: { stringUnit: { state: "new", value } } },
      };
      stats.added++;
      continue;
    }
    if (comment) entry.comment = comment;
    entry.localizations ??= {};
    const src_loc = entry.localizations[SOURCE_LANG];
    if (src_loc?.variations || src_loc?.stringUnit?.state === "translated") {
      delete entry.extractionState;
      continue;
    }
    entry.extractionState = "extracted_with_value";
    if (src_loc?.stringUnit?.value === value) continue;
    entry.localizations[SOURCE_LANG] = { stringUnit: { state: "new", value } };
    let demoted = false;
    for (const [lang, loc] of Object.entries(entry.localizations)) {
      if (lang === SOURCE_LANG) continue;
      for (const [unit] of unitsOf(loc)) {
        if (unit.value && unit.state !== "needs_review") {
          unit.state = "needs_review";
          demoted = true;
        }
      }
    }
    if (demoted) stats.changed++;
  }
  for (const [key, entry] of Object.entries(catalog.strings)) {
    if (!entries.has(key) && entry.extractionState !== "manual") entry.extractionState = "stale";
  }
  return stats;
};

// removed 的键：表名与键用 NUL 分隔，因为键本身可以含任何可见字符
const removedIdOf = (table, key) => table + "\x00" + key;

// 删除 stale 键；有译文的键追加到 removed，供审校参考
export const pruneStale = (catalog, table, removed, today) => {
  let n = 0;
  for (const [key, entry] of Object.entries(catalog.strings)) {
    if (entry.extractionState !== "stale") continue;
    const translations = {};
    for (const [lang, loc] of Object.entries(entry.localizations ?? {})) {
      if (lang === SOURCE_LANG) continue;
      const units = unitsOf(loc).filter(([u]) => u.value);
      if (units.length) translations[lang] = units.length === 1 && units[0][1].length === 0 ? units[0][0].value : loc;
    }
    if (Object.keys(translations).length) {
      const source = unitsOf(sourceLocOf(key, entry)).map(([u]) => u.value);
      removed.set(removedIdOf(table, key), {
        table,
        key,
        source: source.length === 1 ? source[0] : sourceLocOf(key, entry),
        translations,
        removedOn: today,
      });
    }
    delete catalog.strings[key];
    n++;
  }
  return n;
};

// 同一个键在同步前后，是否有译文被改成了 needs_review
const reviewDemoted = (prev, next) =>
  Object.entries(next.localizations ?? {}).some(([lang, loc]) =>
    unitsOf(loc).some(([u, path]) => {
      if (lang === SOURCE_LANG || u.state !== "needs_review") return false;
      const old = unitsOf(prev.localizations?.[lang]).find(([, p]) => p.join("/") === path.join("/"));
      return old !== undefined && old[0].state !== "needs_review";
    }),
  );

// 没有字母的键（例如 "%@"、" "）没有可翻译的文字。只加标记，不撤销：开发者可能有意标了不翻译
export const markUntranslatable = (catalog) => {
  for (const [key, entry] of Object.entries(catalog.strings)) {
    const text = unitsOf(sourceLocOf(key, entry))
      .map(([u]) => u.value)
      .join(" ");
    if (!/\p{L}/u.test(text)) entry.shouldTranslate = false;
  }
};

const readRemoved = (path) =>
  new Map((existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : []).map((e) => [removedIdOf(e.table, e.key), e]));

const serializeRemoved = (removed) =>
  JSON.stringify(
    [...removed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e),
    null,
    2,
  ) + "\n";

// xcstringstool sync 遇到无法读取的 catalog（例如含孤立代理项）时只给警告、退出码仍是 0
const xcstringsSync = (path, stringsdata) => {
  const { stdout, stderr } = runFull("xcrun", "xcstringstool", "sync", path, ...stringsdata.flatMap((p) => ["--stringsdata", p])),
    output = (stdout + "\n" + stderr).trim();
  // 这条警告输出到 stdout
  if (/Skipping sync|could not be read/i.test(output)) throw new Error("xcstringstool sync 没有同步 " + path + "：\n" + output);
};

// 同步全部 catalog，返回每张表同步后的内容与统计
// write 为 true 时写回：先算完全部 3 张表，再先写 removed.json、后写 catalog，中途出错时不会丢失删除记录
export const syncAll = ({ root, build_dir, write, today = new Date().toISOString().slice(0, 10) }) => {
  const stringsdata = stringsdataOf(root, build_dir),
    removed_path = join(root, REMOVED_PATH),
    removed = readRemoved(removed_path),
    result = {},
    tmp = mkdtempSync(join(tmpdir(), "utm-i18n-sync-"));
  try {
    for (const [table, rel] of Object.entries(CATALOG_PATHS)) {
      const path = join(root, rel),
        before = existsSync(path) ? readFileSync(path, "utf8") : null;
      let catalog, stats;
      if (table === "Localizable") {
        const tmp_path = join(tmp, "Localizable.xcstrings");
        if (before === null) writeFileSync(tmp_path, serializeCatalog(readCatalog(path)));
        else copyFileSync(path, tmp_path);
        const prev = readCatalog(tmp_path);
        // 必须一次传入全部 stringsdata：sync 会把这次没出现的键都标为 stale
        xcstringsSync(tmp_path, stringsdata);
        catalog = readCatalog(tmp_path);
        stats = {
          added: Object.keys(catalog.strings).filter((k) => !prev.strings[k]).length,
          changed: Object.keys(catalog.strings).filter((k) => prev.strings[k] && reviewDemoted(prev.strings[k], catalog.strings[k])).length,
        };
      } else {
        catalog = readCatalog(path);
        stats = syncEntries(catalog, table === "InfoPlist" ? infoPlistEntriesOf(root) : xibEntriesOf(root));
      }
      stats.removed = pruneStale(catalog, table, removed, today);
      markUntranslatable(catalog);
      result[table] = { path, before, after: serializeCatalog(catalog), stats };
    }
    if (write) {
      const removed_text = serializeRemoved(removed);
      if (removed.size && removed_text !== (existsSync(removed_path) ? readFileSync(removed_path, "utf8") : "")) {
        writeFileSync(removed_path, removed_text);
      }
      for (const { path, before, after } of Object.values(result)) if (after !== before) writeFileSync(path, after);
    }
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};
