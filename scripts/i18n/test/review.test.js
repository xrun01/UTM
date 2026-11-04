import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PATHS, emptyCatalog, readCatalog, writeCatalog } from "../lib/catalog.js";

const REVIEW = join(import.meta.dirname, "../review.js"),
  unit = (value, state = "translated") => ({ stringUnit: { state, value } });

describe("review.js", () => {
  let root, tmp;
  const run = (...args) => {
      const proc = Bun.spawnSync(["bun", REVIEW, ...args, "--root", root], { stdout: "pipe", stderr: "pipe" });
      return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
    },
    json = (p) => JSON.parse(readFileSync(p, "utf8")),
    write = (p, v) => writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v)),
    catalog = (table = "Localizable") => readCatalog(join(root, CATALOG_PATHS[table])),
    saveCatalog = (cat, table = "Localizable") => writeCatalog(join(root, CATALOG_PATHS[table]), cat),
    catalogText = () => readFileSync(join(root, CATALOG_PATHS.Localizable), "utf8"),
    // 常用操作：导出 de、写 de 的 proposal、写回 de
    exportDe = (...args) => run("export", "--lang", "de", ...args, "--out", join(tmp, "de/export.json")),
    propose = (p, lang = "de") => write(join(tmp, lang, "proposal.json"), { lang, ...p }),
    apply = (...args) => run("apply", "--lang", "de", "--proposal", join(tmp, "de/proposal.json"), ...args),
    OPEN = "Localizable|Open %@|",
    ONE = "Localizable|%lld Cores|plural/one",
    OTHER = "Localizable|%lld Cores|plural/other";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i18n-review-"));
    tmp = join(root, "tmp");
    mkdirSync(join(tmp, "de"), { recursive: true });
    mkdirSync(join(tmp, "ja"), { recursive: true });
    mkdirSync(join(root, "i18n"), { recursive: true });
    write(join(root, "i18n/languages.json"), { source: "en", languages: [{ code: "de" }, { code: "ja" }] });
    for (const rel of Object.values(CATALOG_PATHS)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeCatalog(join(root, rel), emptyCatalog());
    }
    const cat = emptyCatalog();
    cat.strings = {
      "Open %@": { comment: "AppDelegate", localizations: { de: unit("%@ offnen", "needs_review") } },
      Close: { localizations: { de: unit("Schließen") } },
      "New text": {},
      "%@": { shouldTranslate: false },
      "%lld Cores": {
        localizations: {
          de: { variations: { plural: { one: unit("%lld Kern", "needs_review"), other: unit("%lld Kerne", "needs_review") } } },
        },
      },
    };
    saveCatalog(cat);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe("export", () => {
    test("默认只导出 needs_review，复数按变体导出，id 是 表名|键|路径", () => {
      expect(exportDe().code).toBe(0);
      const { items } = json(join(tmp, "de/export.json"));
      // 顺序跟随 catalog：键按码点排序
      expect(items.map((i) => i.id)).toEqual([ONE, OTHER, OPEN]);
      expect(items[2]).toEqual({ id: OPEN, en: "Open %@", comment: "AppDelegate", current: "%@ offnen", state: "needs_review" });
      expect(items[0].en).toBe("%lld Cores");
    });

    test("--state all、--keys、--limit", () => {
      write(join(tmp, "keys.json"), [{ table: "Localizable", key: "Close" }]);
      run("export", "--lang", "de", "--state", "all", "--keys", join(tmp, "keys.json"), "--out", join(tmp, "a.json"));
      expect(json(join(tmp, "a.json")).items.map((i) => i.id)).toEqual(["Localizable|Close|"]);
      run("export", "--lang", "de", "--state", "all", "--limit", "2", "--out", join(tmp, "b.json"));
      expect(json(join(tmp, "b.json")).items).toHaveLength(2);
    });

    test("--state missing：导出缺译的单元，复数按这种语言的类别；不翻译的键不导出", () => {
      exportDe("--state", "missing");
      expect(json(join(tmp, "de/export.json")).items).toEqual([{ id: "Localizable|New text|", en: "New text", comment: "", current: "", state: "missing" }]);
      run("export", "--lang", "ja", "--state", "missing", "--out", join(tmp, "ja/export.json"));
      // 英文没有复数变体时整句导出
      expect(json(join(tmp, "ja/export.json")).items.map((i) => i.id)).toEqual([
        "Localizable|%lld Cores|",
        "Localizable|Close|",
        "Localizable|New text|",
        OPEN,
      ]);
    });

    test("参数错误时退出码 2；输出目录不存在时自动创建", () => {
      expect(run("export", "--lang", "xx", "--out", join(tmp, "a.json")).code).toBe(2);
      expect(exportDe("--state", "bad").code).toBe(2);
      expect(exportDe("--limit", "0").code).toBe(2);
      expect(exportDe("--limit", "abc").code).toBe(2);
      expect(exportDe("--key", "(").code).toBe(2);
      expect(exportDe("--table", "Nope").code).toBe(2);
      write(join(tmp, "keys.json"), { not: "array" });
      expect(exportDe("--keys", join(tmp, "keys.json")).code).toBe(2);
      expect(run("export", "--lang", "de", "--out", join(tmp, "new/dir/a.json")).code).toBe(0);
    });
  });

  test("new-keys：所有语言都缺译、并且需要翻译的键", () => {
    run("new-keys", "--out", join(tmp, "new.json"));
    expect(json(join(tmp, "new.json"))).toEqual([{ table: "Localizable", key: "New text", en: "New text" }]);
  });

  describe("apply", () => {
    test("写入改动与确认，状态改为 translated；doubts 保持原状；--dry-run 不写入", () => {
      exportDe();
      propose({
        changes: [{ id: OPEN, old: "%@ offnen", new: "%@ öffnen", type: "不通顺", reason: "拼写" }],
        approved: [{ id: ONE, value: "%lld Kern" }],
        doubts: [{ id: OTHER, current: "%lld Kerne", question: "q" }],
      });
      expect(apply("--dry-run").out).toContain("检查通过，可以写入 2 条");
      expect(catalogText()).toContain("%@ offnen");
      expect(apply().code).toBe(0);
      const de = catalog().strings;
      expect(de["Open %@"].localizations.de).toEqual(unit("%@ öffnen"));
      expect(de["%lld Cores"].localizations.de.variations.plural.one).toEqual(unit("%lld Kern"));
      expect(de["%lld Cores"].localizations.de.variations.plural.other).toEqual(unit("%lld Kerne", "needs_review"));
    });

    test("可以重复运行：已经写入的条目跳过", () => {
      exportDe();
      propose({
        changes: [{ id: OPEN, old: "%@ offnen", new: "%@ öffnen", type: "不通顺" }],
        approved: [{ id: ONE, value: "%lld Kern" }],
        withdrawn: [{ id: OTHER, reason: "2 轮后仍有分歧" }],
      });
      expect(apply().code).toBe(0);
      const again = apply();
      expect(again.code).toBe(0);
      expect(again.out).toContain("写入 0 条，状态改为 translated，已经写入过的 2 条跳过");
      // withdrawn 的条目保持 needs_review
      expect(catalog().strings["%lld Cores"].localizations.de.variations.plural.other.stringUnit.state).toBe("needs_review");
    });

    test("导出了但 proposal 没有处理的条目：整体拒绝", () => {
      exportDe();
      propose({ approved: [{ id: ONE, value: "%lld Kern" }] });
      const before = catalogText(),
        res = apply();
      expect(res.code).toBe(1);
      expect(res.out).toContain(OPEN + "：导出了，但 proposal 没有处理");
      expect(res.out).toContain(OTHER + "：导出了，但 proposal 没有处理");
      expect(catalogText()).toBe(before);
    });

    test("不覆盖已审校的译文：不在导出结果中的条目一律拒绝", () => {
      exportDe();
      propose({
        changes: [{ id: "Localizable|Close|", old: "Schließen", new: "Zumachen", type: "不通顺" }],
        approved: [{ id: ONE, value: "%lld Kern" }, { id: OTHER, value: "%lld Kerne" }, { id: OPEN, value: "%@ offnen" }],
      });
      const res = apply();
      expect(res.code).toBe(1);
      expect(res.out).toContain("Localizable|Close|：不在导出结果中");
      expect(catalog().strings.Close.localizations.de).toEqual(unit("Schließen"));
    });

    test("导出后状态、译文或英文变了：拒绝，要求重新导出", () => {
      exportDe();
      propose({
        changes: [{ id: OPEN, old: "%@ offnen", new: "%@ öffnen", type: "不通顺" }],
        approved: [{ id: ONE, value: "%lld Kern" }, { id: OTHER, value: "%lld Kerne" }],
      });
      // 导出后有人在 Xcode 里确认了这条
      const cat = catalog();
      cat.strings["Open %@"].localizations.de.stringUnit.state = "translated";
      cat.strings["%lld Cores"].localizations.de.variations.plural.one.stringUnit.value = "%lld Prozessorkern";
      cat.strings["%lld Cores"].localizations.en = { variations: { plural: { one: unit("%lld Core"), other: unit("%lld CPU Cores") } } };
      saveCatalog(cat);
      const res = apply();
      expect(res.code).toBe(1);
      expect(res.out).toContain(OPEN + "：导出后译文或状态变了，现在是 translated \"%@ offnen\"");
      expect(res.out).toContain(ONE + "：导出后译文或状态变了");
      expect(res.out).toContain(OTHER + "：导出后英文变了");
    });

    test("old 与导出时不同、新译文不合格时，不写入任何条目", () => {
      exportDe();
      propose({
        changes: [
          { id: OPEN, old: "%@ öffnen", new: "%@ aufmachen", type: "不通顺" },
          { id: ONE, old: "%lld Kern", new: "%lld Kern %@", type: "语义错误" },
        ],
        approved: [{ id: OTHER, value: "%lld Kerne" }],
      });
      const before = catalogText(),
        res = apply();
      expect(res.code).toBe(1);
      expect(res.out).toContain(OPEN + "：old 与导出时的译文不同");
      expect(res.out).toContain(ONE + "：译文不合格");
      expect(catalogText()).toBe(before);
    });

    test("补译：缺译条目放进 changes，type 是「补译」；复数变体也能补", () => {
      exportDe("--state", "missing");
      propose({ changes: [{ id: "Localizable|New text|", old: "", new: "Neuer Text", type: "补译" }] });
      expect(apply().code).toBe(0);
      expect(catalog().strings["New text"].localizations.de).toEqual(unit("Neuer Text"));

      const cat = catalog();
      cat.strings["%lld Cores"].localizations.en = { variations: { plural: { one: unit("%lld Core"), other: unit("%lld Cores") } } };
      saveCatalog(cat);
      run("export", "--lang", "ja", "--state", "missing", "--key", "Cores", "--out", join(tmp, "ja/export.json"));
      propose({ changes: [{ id: "Localizable|%lld Cores|plural/other", old: "", new: "%lld コア", type: "补译" }] }, "ja");
      expect(run("apply", "--lang", "ja", "--proposal", join(tmp, "ja/proposal.json")).code).toBe(0);
      expect(catalog().strings["%lld Cores"].localizations.ja).toEqual({ variations: { plural: { other: unit("%lld コア") } } });
    });

    test("补译的类型必须对应：缺译条目只能用「补译」，已有译文的条目不能用", () => {
      exportDe("--state", "missing");
      propose({ changes: [{ id: "Localizable|New text|", old: "", new: "Neuer Text", type: "不通顺" }] });
      expect(apply().out).toContain("缺译条目只能放进 changes");
      exportDe();
      propose({
        changes: [{ id: OPEN, old: "%@ offnen", new: "%@ öffnen", type: "补译" }],
        approved: [{ id: ONE, value: "%lld Kern" }, { id: OTHER, value: "%lld Kerne" }],
      });
      expect(apply().out).toContain("只有缺译条目的 type 是「补译」");
    });

    test("导出后缺译条目已被别人补上：拒绝", () => {
      exportDe("--state", "missing");
      propose({ changes: [{ id: "Localizable|New text|", old: "", new: "Neuer Text", type: "补译" }] });
      const cat = catalog();
      cat.strings["New text"].localizations = { de: unit("Neu", "needs_review") };
      saveCatalog(cat);
      expect(apply().out).toContain("导出后译文或状态变了，现在是 needs_review \"Neu\"");
    });

    test("语言不一致、未知语言、缺少 export.json、例外清单格式错误", () => {
      write(join(tmp, "de/proposal.json"), { lang: "ja" });
      expect(apply().code).toBe(1);
      propose({});
      expect(run("apply", "--lang", "xx", "--proposal", join(tmp, "de/proposal.json")).code).toBe(2);
      const no_export = apply();
      expect(no_export.code).toBe(2);
      expect(no_export.out).toContain("先运行 export");
      run("export", "--lang", "ja", "--out", join(tmp, "ja.json"));
      expect(apply("--export", join(tmp, "ja.json")).out).toContain("的语言是 ja");
      exportDe();
      write(join(root, "i18n/check-exceptions.json"), [{ table: "Localizable", key: "Close", rule: "nope", reason: "r" }]);
      const bad = apply();
      expect(bad.code).toBe(2);
      expect(bad.out).toContain("check-exceptions.json 格式错误");
      write(join(tmp, "de/export.json"), { items: "x" });
      expect(apply().code).toBe(2);
    });

    test("proposal 结构错误时整体拒绝，退出码 2", () => {
      const before = catalogText(),
        tryApply = (p) => {
          propose(p);
          return apply();
        };
      const dup = tryApply({
        changes: [{ id: OPEN, old: "%@ offnen", new: "%@ öffnen", type: "不通顺" }],
        approved: [{ id: OPEN, value: "%@ offnen" }],
      });
      expect(dup.code).toBe(2);
      expect(dup.out).toContain("同时出现在 changes 和 approved");
      expect(tryApply({ changes: [{ id: OPEN, old: "%@ offnen", new: "  ", type: "不通顺" }] }).out).toContain("new 必须是非空字符串");
      expect(tryApply({ changes: "x" }).code).toBe(2);
      expect(tryApply({ changes: [{ id: "bad", old: "a", new: "b", type: "不通顺" }] }).out).toContain("id 格式不对");
      expect(tryApply({ changes: [{ id: OPEN, old: "a", new: "b", type: "风格" }] }).out).toContain("type 必须是");
      // 带语言前缀的 id 表名不对，不能绕过重复检查
      expect(tryApply({ approved: [{ id: OPEN, value: "x" }], doubts: [{ id: "de|" + OPEN, question: "q" }] }).out).toContain("id 的表名不对");
      expect(tryApply({ changes: [{ id: OPEN, old: "a", new: "a", type: "不通顺" }] }).out).toContain("新旧译文相同");
      expect(tryApply({ withdrawn: [{ id: OPEN }] }).out).toContain("缺少 reason");
      expect(tryApply({ source_issues: [{ id: OPEN }] }).out).toContain("必须有 id 和 problem");
      expect(catalogText()).toBe(before);
    });

    test("遵守例外清单，与 check.js 一致", () => {
      const cat = catalog();
      cat.strings.Windows = { localizations: { de: unit("Windows", "needs_review") } };
      saveCatalog(cat);
      exportDe("--key", "^Windows$");
      propose({ changes: [{ id: "Localizable|Windows|", old: "Windows", new: "Fensterliste", type: "语义错误" }] });
      expect(apply().out).toContain("缺少专有名词 Windows");
      write(join(root, "i18n/check-exceptions.json"), [{ table: "Localizable", key: "Windows", rule: "term:Windows", reason: "窗口列表" }]);
      expect(apply().code).toBe(0);
      expect(catalog().strings.Windows.localizations.de).toEqual(unit("Fensterliste"));
    });

    test("只写有改动的 catalog；1 个 proposal 可以同时改多个 catalog；键里可以有 |", () => {
      const vm = join(root, CATALOG_PATHS.VMDisplayWindow);
      write(vm, '{"sourceLanguage":"en","strings":{},"version":"1.0"}');
      const info = emptyCatalog();
      info.strings.NSCameraUsageDescription = {
        localizations: { en: unit("Camera access"), de: unit("Kamera", "needs_review") },
      };
      saveCatalog(info, "InfoPlist");
      const cat = catalog();
      cat.strings["A|B"] = { localizations: { de: unit("A|B", "needs_review") } };
      saveCatalog(cat);
      exportDe("--key", "^(A\\|B|NSCameraUsageDescription)$");
      expect(json(join(tmp, "de/export.json")).items.map((i) => i.id)).toEqual(["Localizable|A|B|", "InfoPlist|NSCameraUsageDescription|"]);
      propose({
        changes: [{ id: "InfoPlist|NSCameraUsageDescription|", old: "Kamera", new: "Kamerazugriff", type: "漏译" }],
        approved: [{ id: "Localizable|A|B|", value: "A|B" }],
      });
      expect(apply().code).toBe(0);
      expect(catalog("InfoPlist").strings.NSCameraUsageDescription.localizations.de).toEqual(unit("Kamerazugriff"));
      expect(catalog().strings["A|B"].localizations.de).toEqual(unit("A|B"));
      expect(readFileSync(vm, "utf8")).toBe('{"sourceLanguage":"en","strings":{},"version":"1.0"}');
    });
  });

  describe("回译与比对", () => {
    const backInput = (out, ...args) => run("back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, out), ...args),
      compareInput = () => run("compare-input", "--dir", tmp, "--langs", "de,ja", "--out", join(tmp, "cmp.json")),
      proposeOpen = (text) =>
        propose({
          changes: [{ id: OPEN, old: "%@ offnen", new: text, type: "不通顺" }],
          approved: [{ id: ONE, value: "%lld Kern" }],
          doubts: [{ id: OTHER, question: "q" }],
        });

    test("回译输入用不透明编号，看不到英文原文；compare-input 只取当前译文的回译", () => {
      exportDe();
      proposeOpen("%@ öffnen");
      backInput("de/back-input.json");
      const input = json(join(tmp, "de/back-input.json"));
      expect(input.map((i) => i.text)).toEqual(["%@ öffnen", "%lld Kern"]);
      expect(JSON.stringify(input)).not.toContain("Open");
      expect(JSON.stringify(input)).not.toContain("Localizable");
      const [open_id] = input.map((i) => i.id);

      write(join(tmp, "de/back.json"), [{ id: open_id, back: "Open %@", note: "ok" }]);
      const cmp = compareInput();
      expect(json(join(tmp, "cmp.json"))).toEqual([{ id: "de|" + OPEN, en: "Open %@", back: "Open %@", note: "ok" }]);
      expect(cmp.out).toContain("缺少当前译文的回译：" + ONE);
      expect(cmp.out).toContain("ja：没有 export.json，跳过");
    });

    test("back-input 默认只输出没有当前译文回译的条目；改过的条目自动重新回译", () => {
      exportDe();
      proposeOpen("%@ öffnen");
      backInput("de/back-input.json");
      write(
        join(tmp, "de/back.json"),
        json(join(tmp, "de/back-input.json")).map((i) => ({ id: i.id, back: "B:" + i.text })),
      );
      expect(backInput("de/back2-input.json").out).toContain("不用再回译");
      expect(json(join(tmp, "de/back2-input.json"))).toEqual([]);

      // 改稿代理改了译文：只有这一条需要重新回译
      proposeOpen("%@ aufmachen");
      backInput("de/back2-input.json");
      const [redo] = json(join(tmp, "de/back2-input.json"));
      expect(redo.text).toBe("%@ aufmachen");
      write(join(tmp, "de/back2.json"), [{ id: redo.id, back: "Open up %@" }]);
      compareInput();
      expect(json(join(tmp, "cmp.json")).map((i) => i.back)).toEqual(["Open up %@", "B:%lld Kern"]);

      // 改回第 1 轮的译文：第 1 轮的回译仍然有效，不用再回译
      proposeOpen("%@ öffnen");
      expect(backInput("de/back3-input.json").out).toContain("不用再回译");
    });

    test("同一编号的多轮回译以后一轮为准，back10 排在 back2 之后", () => {
      exportDe();
      proposeOpen("%@ öffnen");
      backInput("de/in.json");
      const [{ id }] = json(join(tmp, "de/in.json"));
      write(join(tmp, "de/back10.json"), [{ id, back: "round 10" }]);
      write(join(tmp, "de/back2.json"), [{ id, back: "round 2" }]);
      write(join(tmp, "de/back.json"), [{ id, back: "round 1" }]);
      compareInput();
      expect(json(join(tmp, "cmp.json"))[0].back).toBe("round 10");
    });

    test("--ids-file：比对代理的输出可以直接用，已有回译也重新输出；不匹配时警告，全部不匹配时失败", () => {
      exportDe();
      proposeOpen("%@ öffnen");
      backInput("de/in.json");
      write(join(tmp, "de/back.json"), json(join(tmp, "de/in.json")).map((i) => ({ id: i.id, back: "x" })));
      write(join(tmp, "redo.json"), [{ id: "de|" + OPEN, type: "意思不同" }, "Localizable|Gone|"]);
      const partial = backInput("de/in2.json", "--ids-file", join(tmp, "redo.json"));
      expect(partial.code).toBe(0);
      expect(partial.out).toContain("1 条不在 proposal");
      expect(json(join(tmp, "de/in2.json")).map((i) => i.text)).toEqual(["%@ öffnen"]);
      write(join(tmp, "none.json"), ["ja|" + OPEN]);
      expect(backInput("de/in3.json", "--ids-file", join(tmp, "none.json")).code).toBe(1);
    });

    test("输入文件格式不对时退出码 2", () => {
      exportDe();
      proposeOpen("%@ öffnen");
      write(join(tmp, "de/back.json"), { items: [] });
      expect(compareInput().code).toBe(2);
      write(join(tmp, "de/back.json"), "[]");
      propose({ changes: "x" });
      expect(compareInput().code).toBe(2);
      expect(backInput("de/in.json").code).toBe(2);
    });

    test("compare-input：proposal 中不在 export.json 的条目不进比对输入，并提示", () => {
      exportDe("--key", "Open");
      proposeOpen("%@ öffnen");
      backInput("de/in.json");
      write(join(tmp, "de/back.json"), json(join(tmp, "de/in.json")).map((i) => ({ id: i.id, back: "x" })));
      const res = compareInput();
      expect(res.out).toContain("不在 export.json 中：" + ONE);
      expect(json(join(tmp, "cmp.json")).map((i) => i.id)).toEqual(["de|" + OPEN]);
    });
  });

  describe("report", () => {
    const report = (langs = "de") => run("report", "--dir", tmp, "--langs", langs, "--out", join(tmp, "r.html")),
      html = () => readFileSync(join(tmp, "r.html"), "utf8");

    test("跳过没有 proposal 的语言；列出比对结论、撤回的条目和缺回译的条数", () => {
      exportDe();
      propose({
        approved: [{ id: ONE, value: "%lld Kern" }],
        withdrawn: [{ id: OPEN, reason: "2 轮后仍有分歧" }],
      });
      write(join(tmp, "compare.json"), [{ id: "de|" + OPEN, type: "意思不同", problem: "p" }]);
      const res = report("de,ja");
      expect(res.code).toBe(0);
      expect(res.out).toContain("ja：没有 proposal.json");
      expect(html()).toContain('"withdrawn":[{"id":"Localizable|Open %@|","reason":"2 轮后仍有分歧","en":"Open %@","current":"%@ offnen"}]');
      expect(html()).toContain('"mismatches":[{"id":"Localizable|Open %@|","type":"意思不同","problem":"p","en":"Open %@"}]');
      expect(html()).toContain('"no_back":1');
    });

    test("只显示当前译文的回译", () => {
      exportDe();
      propose({ changes: [{ id: OPEN, old: "%@ offnen", new: "%@ öffnen", type: "不通顺" }] });
      run("back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, "de/in.json"));
      write(join(tmp, "de/back.json"), json(join(tmp, "de/in.json")).map((i) => ({ id: i.id, back: "Open %@", note: "n" })));
      write(join(tmp, "compare.json"), "[]");
      report();
      expect(html()).toContain('"back":"Open %@","note":"n"');
      expect(html()).toContain('"no_back":0');
      // 回译后又改了译文：旧回译不再显示
      propose({ changes: [{ id: OPEN, old: "%@ offnen", new: "%@ aufmachen", type: "不通顺" }] });
      report();
      expect(html()).toContain('"back":"","note":""');
      expect(html()).toContain('"no_back":1');
    });

    test("没有 compare.json，或 compare.json 早于回译时警告；compare.json 不是数组时退出码 2", () => {
      exportDe();
      propose({});
      expect(report().out).toContain("没有 " + join(tmp, "compare.json"));
      write(join(tmp, "compare.json"), "[]");
      write(join(tmp, "de/back2.json"), "[]");
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(tmp, "compare.json"), old, old);
      expect(report().out).toContain("de/back2.json 比 compare.json 新");
      write(join(tmp, "compare.json"), { items: [] });
      expect(report().code).toBe(2);
    });

    test("数据中的 < 被转义，</script> 不能提前结束脚本", () => {
      exportDe();
      propose({
        changes: [{ id: OPEN, old: "%@ offnen", new: "<b>%@</b> öffnen", type: "不通顺", reason: "</script><script>alert(1)</script>" }],
        doubts: [{ id: ONE, current: "y", question: "z" }],
      });
      write(join(tmp, "compare.json"), "[]");
      expect(report().code).toBe(0);
      expect(html()).toContain("<title>UTM 译文审校</title>");
      expect(html()).not.toContain("<b>%@</b>");
      expect(html()).not.toContain("</script><script>");
      expect(html()).toContain("\\u003cb>%@\\u003c/b>");
    });
  });

  test("未知子命令或缺少参数时退出码 2", () => {
    expect(run("nope").code).toBe(2);
    expect(run("export", "--lang", "de").code).toBe(2);
  });
});
