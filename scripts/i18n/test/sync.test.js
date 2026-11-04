import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PATHS, emptyCatalog, readCatalog, writeCatalog } from "../lib/catalog.js";
import { INFO_PLIST_PATH, XIB_PATH } from "../lib/extract.js";
import { xcrun } from "../lib/run.js";
import { REMOVED_PATH, markUntranslatable, pruneStale, stringsdataOf, syncAll, syncEntries } from "../lib/sync.js";

const REPO = join(import.meta.dirname, "../../.."),
  unit = (value, state = "translated") => ({ stringUnit: { state, value } }),
  entries = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, { value: v, comment: "c " + k }]));

describe("syncEntries", () => {
  test("新增键带英文与注释", () => {
    const cat = emptyCatalog(),
      stats = syncEntries(cat, entries({ K: "Hello" }));
    expect(stats).toEqual({ added: 1, changed: 0 });
    expect(cat.strings.K).toEqual({
      comment: "c K",
      extractionState: "extracted_with_value",
      localizations: { en: unit("Hello", "new") },
    });
  });

  test("英文变化：更新英文，translated 改为 needs_review，其他状态不变", () => {
    const cat = emptyCatalog();
    syncEntries(cat, entries({ K: "Hello" }));
    cat.strings.K.localizations.de = unit("Hallo");
    cat.strings.K.localizations.ja = unit("こんにちは", "needs_review");
    const stats = syncEntries(cat, entries({ K: "Hi" }));
    expect(stats.changed).toBe(1);
    expect(cat.strings.K.localizations.en).toEqual(unit("Hi", "new"));
    expect(cat.strings.K.localizations.de).toEqual(unit("Hallo", "needs_review"));
    expect(cat.strings.K.localizations.ja.stringUnit.state).toBe("needs_review");
  });

  test("英文不变时不改动译文状态", () => {
    const cat = emptyCatalog();
    syncEntries(cat, entries({ K: "Hello" }));
    cat.strings.K.localizations.de = unit("Hallo");
    expect(syncEntries(cat, entries({ K: "Hello" }))).toEqual({ added: 0, changed: 0 });
    expect(cat.strings.K.localizations.de.stringUnit.state).toBe("translated");
  });

  test("源码中消失的键标为 stale，手动键不标", () => {
    const cat = emptyCatalog();
    cat.strings.Gone = { extractionState: "extracted_with_value" };
    cat.strings.Manual = { extractionState: "manual" };
    syncEntries(cat, entries({}));
    expect(cat.strings.Gone.extractionState).toBe("stale");
    expect(cat.strings.Manual.extractionState).toBe("manual");
  });
});

describe("pruneStale", () => {
  test("删除 stale 键；有译文的记入 removed，没有译文的不记", () => {
    const cat = emptyCatalog(),
      removed = new Map();
    cat.strings["Old text"] = { extractionState: "stale", localizations: { de: unit("Alter Text") } };
    cat.strings["No translation"] = { extractionState: "stale" };
    cat.strings.Live = {};
    expect(pruneStale(cat, "Localizable", removed, "2026-11-04")).toBe(2);
    expect(Object.keys(cat.strings)).toEqual(["Live"]);
    expect([...removed.values()]).toEqual([
      { table: "Localizable", key: "Old text", source: "Old text", translations: { de: "Alter Text" }, removedOn: "2026-11-04" },
    ]);
  });

  test("复数译文整体记录", () => {
    const cat = emptyCatalog(),
      removed = new Map(),
      plural = { variations: { plural: { one: unit("%lld Kern"), other: unit("%lld Kerne") } } };
    cat.strings["%lld Cores"] = { extractionState: "stale", localizations: { de: plural } };
    pruneStale(cat, "Localizable", removed, "2026-11-04");
    expect([...removed.values()][0].translations.de).toEqual(plural);
  });
});

test("markUntranslatable：没有字母的键标为不翻译", () => {
  const cat = emptyCatalog();
  for (const k of ["", " ", "%@", "%1$@ (%2$@)", "Hello", "中文"]) cat.strings[k] = {};
  markUntranslatable(cat);
  expect(Object.keys(cat.strings).filter((k) => cat.strings[k].shouldTranslate === false)).toEqual(["", " ", "%@", "%1$@ (%2$@)"]);
});

describe("stringsdataOf", () => {
  let root, build;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i18n-root-"));
    build = join(root, "build/i18n");
    mkdirSync(join(root, "Src"), { recursive: true });
    mkdirSync(join(build, "stringsdata/swiftc"), { recursive: true });
    mkdirSync(join(build, "stringsdata/extract"), { recursive: true });
    writeFileSync(join(root, "Src/A.swift"), "");
    writeFileSync(join(root, "Src/B.m"), "");
    writeFileSync(join(build, "manifest.json"), JSON.stringify({ swift: ["Src/A.swift"], objc: ["Src/B.m"] }));
    for (const p of ["swiftc/A.stringsdata", "extract/A-swift.stringsdata", "extract/B-m.stringsdata"]) {
      writeFileSync(join(build, "stringsdata", p), "");
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("完整时返回全部 stringsdata", () => expect(stringsdataOf(root, build)).toHaveLength(3));

  test("没有清单", () => {
    rmSync(join(build, "manifest.json"));
    expect(() => stringsdataOf(root, build)).toThrow("manifest.json");
  });

  test("缺少 stringsdata", () => {
    rmSync(join(build, "stringsdata/extract/B-m.stringsdata"));
    expect(() => stringsdataOf(root, build)).toThrow("缺少 stringsdata: extract/B-m.stringsdata");
  });

  test("新增的源文件不在清单中", () => {
    writeFileSync(join(root, "Src/C.swift"), "");
    expect(() => stringsdataOf(root, build)).toThrow("新增的源文件不在构建清单中: Src/C.swift");
  });

  test("清单中的源文件已删除", () => {
    rmSync(join(root, "Src/A.swift"));
    expect(() => stringsdataOf(root, build)).toThrow("构建清单中的源文件已删除: Src/A.swift");
  });

  test("源文件在构建后被修改", () => {
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "Src/A.swift"), later, later);
    expect(() => stringsdataOf(root, build)).toThrow("源文件在构建后被修改: Src/A.swift");
  });
});

// 集成测试：用真实的 swiftc、xcstringstool、ibtool 走一遍完整流程
describe("syncAll", () => {
  let root;
  const build = () => join(root, "build/i18n"),
    // 模拟 vm/script/lib/sdkBuild.js 的提取步骤
    extract = (swift_src) => {
      writeFileSync(join(root, "Src/A.swift"), swift_src);
      rmSync(build(), { recursive: true, force: true });
      const swiftc = join(build(), "stringsdata/swiftc"),
        ext = join(build(), "stringsdata/extract"),
        objs = join(root, "build/objs");
      for (const d of [swiftc, ext, objs]) mkdirSync(d, { recursive: true });
      const sdk = xcrun("--sdk", "macosx", "--show-sdk-path").trim(),
        src = join(root, "Src/A.swift");
      const proc = Bun.spawnSync(
        ["xcrun", "swiftc", "-c", "-sdk", sdk, "-target", "arm64-apple-macos14.0", "-emit-localized-strings", "-emit-localized-strings-path", swiftc, src],
        { cwd: objs, stderr: "pipe" },
      );
      if (proc.exitCode !== 0) throw new Error("swiftc 失败: " + proc.stderr.toString());
      xcrun("xcstringstool", "extract", "--legacy-localizable-strings", "--modern-localizable-strings", "-o", ext, src);
      writeFileSync(join(build(), "manifest.json"), JSON.stringify({ swift: ["Src/A.swift"], objc: [] }));
    };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i18n-sync-"));
    for (const rel of [INFO_PLIST_PATH, XIB_PATH]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      copyFileSync(join(REPO, rel), join(root, rel));
    }
    mkdirSync(join(root, "Src"), { recursive: true });
    mkdirSync(join(root, "i18n"), { recursive: true });
    for (const rel of Object.values(CATALOG_PATHS)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeCatalog(join(root, rel), emptyCatalog());
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("新增文案 → 加译文 → 删除文案：键被删除，译文记入 removed.json", () => {
    extract('import Foundation\nlet a = String(localized: "Keep")\nlet b = NSLocalizedString("Drop me", comment: "x")\n');
    const first = syncAll({ root, build_dir: build(), write: true, today: "2026-11-04" });
    expect(first.Localizable.stats.added).toBe(2);
    expect(first.InfoPlist.stats.added).toBe(2);
    expect(first.VMDisplayWindow.stats.added).toBe(30);

    const path = join(root, CATALOG_PATHS.Localizable),
      cat = readCatalog(path);
    cat.strings["Drop me"].localizations = { de: unit("Weg") };
    writeCatalog(path, cat);

    // 同步结果是不动点：再同步 1 次没有变化
    const again = syncAll({ root, build_dir: build(), write: false });
    expect(Object.values(again).every((r) => r.before === r.after)).toBe(true);

    extract('import Foundation\nlet a = String(localized: "Keep")\n');
    const second = syncAll({ root, build_dir: build(), write: true, today: "2026-11-05" });
    expect(second.Localizable.stats.removed).toBe(1);
    expect(Object.keys(readCatalog(path).strings)).toEqual(["Keep"]);
    expect(JSON.parse(readFileSync(join(root, REMOVED_PATH), "utf8"))).toEqual([
      { table: "Localizable", key: "Drop me", source: "Drop me", translations: { de: "Weg" }, removedOn: "2026-11-05" },
    ]);
  });

  test("write 为 false 时不修改任何文件", () => {
    extract('import Foundation\nlet a = String(localized: "Keep")\n');
    const before = readFileSync(join(root, CATALOG_PATHS.Localizable), "utf8"),
      result = syncAll({ root, build_dir: build(), write: false });
    expect(result.Localizable.after).not.toBe(before);
    expect(readFileSync(join(root, CATALOG_PATHS.Localizable), "utf8")).toBe(before);
  });
});
