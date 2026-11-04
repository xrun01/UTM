// 提取 Info.plist 与 xib 中的文案；Swift 与 ObjC 的文案由构建输出的 stringsdata 提供

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plistOf, xcrun } from "./run.js";

export const INFO_PLIST_PATH = "Platform/macOS/Info.plist",
  XIB_PATH = "Platform/macOS/Display/Base.lproj/VMDisplayWindow.xib";

// NSMicrophoneUsageDescription → "Privacy - Microphone Usage Description"，与 Xcode 的注释一致
const usageCommentOf = (key) =>
  "Privacy - " +
  key
    .replace(/^NS/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();

// 返回 Map<键, { value, comment }>
// 隐私说明以 plist 键为键；文档类型名和 UTType 描述以文字本身为键，这是 InfoPlist.strings 的约定
// CFBundleName 是品牌名，不翻译，所以不提取
export const infoPlistEntriesOf = (root) => {
  const plist = plistOf(join(root, INFO_PLIST_PATH)),
    out = new Map(),
    add = (key, value, comment) => {
      if (typeof value === "string" && value && !out.has(key)) out.set(key, { value, comment });
    };
  for (const key of Object.keys(plist).sort()) {
    if (/^NS\w+UsageDescription$/.test(key)) add(key, plist[key], usageCommentOf(key));
  }
  for (const doc of plist.CFBundleDocumentTypes ?? []) {
    add(doc.CFBundleTypeName, doc.CFBundleTypeName, "Document type name");
  }
  for (const list of [plist.UTExportedTypeDeclarations, plist.UTImportedTypeDeclarations]) {
    for (const type of list ?? []) add(type.UTTypeDescription, type.UTTypeDescription, "Type description");
  }
  return out;
};

// ibtool 导出的 .strings 每条前面有 /* Class = "..."; label = "..."; ObjectID = "..."; */ 注释
const XIB_ENTRY_RE = /\/\*\s*([\s\S]*?)\s*\*\/\s*"((?:[^"\\]|\\.)*)"\s*=/g;

export const xibEntriesOf = (root) => {
  const dir = mkdtempSync(join(tmpdir(), "utm-i18n-xib-")),
    strings_path = join(dir, "VMDisplayWindow.strings");
  try {
    xcrun("ibtool", "--export-strings-file", strings_path, join(root, XIB_PATH));
    const values = plistOf(strings_path),
      buf = readFileSync(strings_path),
      // ibtool 输出 UTF-16（带 BOM）
      text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8"),
      comments = new Map([...text.matchAll(XIB_ENTRY_RE)].map((m) => [m[2], m[1]])),
      out = new Map();
    for (const key of Object.keys(values).sort()) {
      out.set(key, { value: values[key], comment: comments.get(key) ?? "" });
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
