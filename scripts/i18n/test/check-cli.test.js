import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PATHS, emptyCatalog, writeCatalog } from "../lib/catalog.js";

const CHECK = join(import.meta.dirname, "../check.js");

// 在临时 git 仓库中运行 check.js，返回 { code, out }
const runCheck = (root, ...args) => {
  const proc = Bun.spawnSync(["bun", CHECK, "--root", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
};

describe("check.js 命令行", () => {
  let root;
  const writeExceptions = (list) => writeFileSync(join(root, "i18n/check-exceptions.json"), JSON.stringify(list));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i18n-cli-"));
    Bun.spawnSync(["git", "init", "-q", root]);
    mkdirSync(join(root, "i18n"), { recursive: true });
    writeFileSync(join(root, "i18n/languages.json"), JSON.stringify({ source: "en", languages: [{ code: "de" }, { code: "ja" }] }));
    for (const rel of Object.values(CATALOG_PATHS)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeCatalog(join(root, rel), emptyCatalog());
    }
    const cat = emptyCatalog();
    cat.strings.Windows = { localizations: { de: { stringUnit: { state: "translated", value: "Fenster" } } } };
    writeCatalog(join(root, CATALOG_PATHS.Localizable), cat);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("没有错误时退出码 0；缺译只给警告", () => {
    writeExceptions([{ table: "Localizable", key: "Windows", rule: "term:Windows", reason: "窗口" }]);
    const { code, out } = runCheck(root);
    expect(code).toBe(0);
    expect(out).toContain("[ja] 缺译 1 条");
  });

  test("有错误时退出码 1", () => {
    const { code, out } = runCheck(root);
    expect(code).toBe(1);
    expect(out).toContain("缺少专有名词 Windows");
  });

  test("没有 git add 的新文件也会扫描；工作区中已删除的文件跳过", () => {
    writeExceptions([{ table: "Localizable", key: "Windows", rule: "term:Windows", reason: "窗口" }]);
    writeFileSync(join(root, "Gone.swift"), "");
    Bun.spawnSync(["git", "-C", root, "add", "Gone.swift"]);
    rmSync(join(root, "Gone.swift"));
    writeFileSync(join(root, "New.swift"), 'let a = Text("中文")\n');
    const { code, out } = runCheck(root);
    expect(code).toBe(1);
    expect(out).toContain('New.swift:1 字符串字面量含中日韩文字，改成英文文案: "中文"');
  });

  test("源码字面量可以写例外", () => {
    writeExceptions([
      { table: "Localizable", key: "Windows", rule: "term:Windows", reason: "窗口" },
      { file: "Lang.swift", text: "简体中文", rule: "source-cjk-literal", reason: "语言选择列表显示语言的自称" },
    ]);
    writeFileSync(join(root, "Lang.swift"), 'let a = "简体中文"\n');
    expect(runCheck(root).code).toBe(0);
  });

  test("没有命中的例外报错；只检查部分语言时不报", () => {
    writeExceptions([
      { table: "Localizable", key: "Windows", rule: "term:Windows", reason: "窗口" },
      { table: "Localizable", key: "Gone", rule: "format", reason: "已修好" },
    ]);
    const all = runCheck(root);
    expect(all.code).toBe(1);
    expect(all.out).toContain("例外没有命中任何问题");
    expect(runCheck(root, "--lang", "de").code).toBe(0);
  });

  test("catalog 缺失时退出码 1", () => {
    rmSync(join(root, CATALOG_PATHS.InfoPlist));
    writeExceptions([{ table: "Localizable", key: "Windows", rule: "term:Windows", reason: "窗口" }]);
    const { code, out } = runCheck(root);
    expect(code).toBe(1);
    expect(out).toContain("catalog 不存在");
  });

  test("参数错误时退出码 2：未知语言、空的 --lang、未知选项、例外格式错误", () => {
    expect(runCheck(root, "--lang", "xx").code).toBe(2);
    expect(runCheck(root, "--lang=").code).toBe(2);
    expect(runCheck(root, "--nope").code).toBe(2);
    writeExceptions([{ table: "Localizable", key: "Windows", rule: "length", reason: "x" }]);
    const bad = runCheck(root);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("rule 不是可以写例外的规则");
  });
});
