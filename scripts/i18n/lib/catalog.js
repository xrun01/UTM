// String Catalog（.xcstrings）的读写与遍历
// 写出格式与 xcstringstool 逐字节一致，否则 sync 和 Xcode 每次都会产生无意义的 diff

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 表名 → catalog 相对仓库根目录的路径；表名决定编译出的 <表名>.strings
export const CATALOG_PATHS = {
  Localizable: "Platform/Localizable.xcstrings",
  InfoPlist: "Platform/macOS/InfoPlist.xcstrings",
  VMDisplayWindow: "Platform/macOS/Display/VMDisplayWindow.xcstrings",
};

export const SOURCE_LANG = "en";

export const emptyCatalog = () => ({ sourceLanguage: SOURCE_LANG, strings: {}, version: "1.0" });

// xcstringstool 按 Unicode 码点排序，等同于 UTF-8 字节序；JS 默认的 UTF-16 码元比较在 emoji 与全角字符之间结果不同
const keyCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const serializeValue = (value, indent) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[\n\n" + indent + "]";
    return "[\n" + value.map((v) => inner + serializeValue(v, inner)).join(",\n") + "\n" + indent + "]";
  }
  const keys = Object.keys(value).sort(keyCompare);
  if (keys.length === 0) return "{\n\n" + indent + "}";
  return (
    "{\n" +
    keys.map((k) => inner + JSON.stringify(k) + " : " + serializeValue(value[k], inner)).join(",\n") +
    "\n" +
    indent +
    "}"
  );
};

export const serializeCatalog = (catalog) => serializeValue(catalog, "");

export const readCatalog = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : emptyCatalog());

export const writeCatalog = (path, catalog) => writeFileSync(path, serializeCatalog(catalog));

export const catalogPathOf = (root, table) => join(root, CATALOG_PATHS[table]);

// 遍历一种语言下的全部 stringUnit，包括复数等 variations；回调参数是 (unit, 变体路径数组)
export const unitsOf = (loc, path = []) => {
  if (!loc) return [];
  const out = [];
  if (loc.stringUnit) out.push([loc.stringUnit, path]);
  for (const [kind, variants] of Object.entries(loc.variations ?? {})) {
    for (const [name, sub] of Object.entries(variants)) out.push(...unitsOf(sub, [...path, kind, name]));
  }
  return out;
};

// 按变体路径取 stringUnit；路径为空时取顶层 stringUnit
export const unitAt = (loc, path) => {
  let cur = loc;
  for (let i = 0; i < path.length && cur; i += 2) cur = cur.variations?.[path[i]]?.[path[i + 1]];
  return cur?.stringUnit;
};

export const hasTranslation = (entry, lang) => unitsOf(entry.localizations?.[lang]).some(([u]) => u.value !== undefined && u.value !== "");

// 英文原文：优先取 en 的值（xcstringstool 会把多参数格式改写成带序号的形式），没有时就是键本身
export const sourceLocOf = (key, entry) =>
  entry.localizations?.[SOURCE_LANG] ?? { stringUnit: { state: "new", value: key } };

export const isTranslatable = (entry) => entry.shouldTranslate !== false;
