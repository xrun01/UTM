import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    catalog = () => readCatalog(join(root, CATALOG_PATHS.Localizable));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "i18n-review-"));
    tmp = join(root, "tmp");
    mkdirSync(join(tmp, "de"), { recursive: true });
    mkdirSync(join(root, "i18n"), { recursive: true });
    writeFileSync(join(root, "i18n/languages.json"), JSON.stringify({ source: "en", languages: [{ code: "de" }, { code: "ja" }] }));
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
    writeCatalog(join(root, CATALOG_PATHS.Localizable), cat);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("export：默认只导出 needs_review，复数按变体导出，id 是 表名|键|路径", () => {
    expect(run("export", "--lang", "de", "--out", join(tmp, "de/export.json")).code).toBe(0);
    const { items } = json(join(tmp, "de/export.json"));
    // 顺序跟随 catalog：键按码点排序
    expect(items.map((i) => i.id)).toEqual(["Localizable|%lld Cores|plural/one", "Localizable|%lld Cores|plural/other", "Localizable|Open %@|"]);
    expect(items[2]).toEqual({ id: "Localizable|Open %@|", en: "Open %@", comment: "AppDelegate", current: "%@ offnen", state: "needs_review" });
    expect(items[0].en).toBe("%lld Cores");
  });

  test("export：--state all、--keys、--limit", () => {
    writeFileSync(join(tmp, "keys.json"), JSON.stringify([{ table: "Localizable", key: "Close" }]));
    run("export", "--lang", "de", "--state", "all", "--keys", join(tmp, "keys.json"), "--out", join(tmp, "a.json"));
    expect(json(join(tmp, "a.json")).items.map((i) => i.id)).toEqual(["Localizable|Close|"]);
    run("export", "--lang", "de", "--state", "all", "--limit", "2", "--out", join(tmp, "b.json"));
    expect(json(join(tmp, "b.json")).items).toHaveLength(2);
    expect(run("export", "--lang", "de", "--state", "bad", "--out", join(tmp, "c.json")).code).toBe(2);
  });

  test("new-keys：所有语言都缺译、并且需要翻译的键", () => {
    run("new-keys", "--out", join(tmp, "new.json"));
    expect(json(join(tmp, "new.json"))).toEqual([{ table: "Localizable", key: "New text", en: "New text" }]);
  });

  test("apply：写入改动与确认，状态改为 translated", () => {
    writeFileSync(
      join(tmp, "de/proposal.json"),
      JSON.stringify({
        lang: "de",
        changes: [{ id: "Localizable|Open %@|", old: "%@ offnen", new: "%@ öffnen", type: "不通顺", reason: "拼写" }],
        approved: [{ id: "Localizable|%lld Cores|plural/one", value: "%lld Kern" }],
      }),
    );
    expect(run("apply", "--lang", "de", "--proposal", join(tmp, "de/proposal.json"), "--dry-run").code).toBe(0);
    expect(catalog().strings["Open %@"].localizations.de).toEqual(unit("%@ offnen", "needs_review"));
    const res = run("apply", "--lang", "de", "--proposal", join(tmp, "de/proposal.json"));
    expect(res.code).toBe(0);
    const cat = catalog();
    expect(cat.strings["Open %@"].localizations.de).toEqual(unit("%@ öffnen"));
    expect(cat.strings["%lld Cores"].localizations.de.variations.plural.one).toEqual(unit("%lld Kern"));
    expect(cat.strings["%lld Cores"].localizations.de.variations.plural.other.stringUnit.state).toBe("needs_review");
  });

  test("apply：原译文已变化、新译文不合格、id 不存在时，不写入任何条目", () => {
    const before = readFileSync(join(root, CATALOG_PATHS.Localizable), "utf8");
    writeFileSync(
      join(tmp, "de/proposal.json"),
      JSON.stringify({
        lang: "de",
        changes: [
          { id: "Localizable|Close|", old: "Schliessen", new: "Zu", type: "不通顺" },
          { id: "Localizable|Open %@|", old: "%@ offnen", new: "öffnen", type: "不通顺" },
          { id: "Localizable|Gone|", old: "x", new: "y", type: "不通顺" },
        ],
        approved: [{ id: "Localizable|%lld Cores|plural/one", value: "%lld Kern" }],
      }),
    );
    const { code, out } = run("apply", "--lang", "de", "--proposal", join(tmp, "de/proposal.json"));
    expect(code).toBe(1);
    expect(out).toContain("原译文已变化");
    expect(out).toContain("新译文不合格");
    expect(out).toContain("catalog 中没有这条译文");
    expect(readFileSync(join(root, CATALOG_PATHS.Localizable), "utf8")).toBe(before);
  });

  test("apply：proposal 的语言不一致时拒绝；未知语言、例外清单格式错误时退出码 2", () => {
    writeFileSync(join(tmp, "de/proposal.json"), JSON.stringify({ lang: "ja", changes: [] }));
    expect(run("apply", "--lang", "de", "--proposal", join(tmp, "de/proposal.json")).code).toBe(1);
    writeFileSync(join(tmp, "de/proposal.json"), JSON.stringify({ lang: "xx" }));
    expect(run("apply", "--lang", "xx", "--proposal", join(tmp, "de/proposal.json")).code).toBe(2);
    writeFileSync(join(tmp, "de/proposal.json"), JSON.stringify({ lang: "de" }));
    writeFileSync(join(root, "i18n/check-exceptions.json"), JSON.stringify([{ table: "Localizable", key: "Close", rule: "nope", reason: "r" }]));
    const bad = run("apply", "--lang", "de", "--proposal", join(tmp, "de/proposal.json"));
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("check-exceptions.json 格式错误");
  });

  test("back-input：回译输入用不透明 id，看不到英文原文；compare-input 按映射还原，后一轮覆盖前一轮", () => {
    run("export", "--lang", "de", "--out", join(tmp, "de/export.json"));
    writeFileSync(
      join(tmp, "de/proposal.json"),
      JSON.stringify({
        lang: "de",
        changes: [{ id: "Localizable|Open %@|", old: "%@ offnen", new: "%@ öffnen", type: "不通顺" }],
        approved: [{ id: "Localizable|%lld Cores|plural/one", value: "%lld Kern" }],
      }),
    );
    run("back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, "de/back-input.json"));
    const input = json(join(tmp, "de/back-input.json"));
    expect(input.map((i) => i.text)).toEqual(["%@ öffnen", "%lld Kern"]);
    expect(JSON.stringify(input)).not.toContain("Open");
    expect(JSON.stringify(input)).not.toContain("Localizable");
    const [open_id] = input.map((i) => i.id);

    // 比对代理的输出可以直接作为 --ids-file
    writeFileSync(join(tmp, "redo.json"), JSON.stringify([{ id: "de|Localizable|Open %@|", type: "意思不同" }]));
    run("back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, "de/back-input2.json"), "--ids-file", join(tmp, "redo.json"));
    expect(json(join(tmp, "de/back-input2.json"))).toEqual([{ id: open_id, text: "%@ öffnen" }]);

    writeFileSync(join(tmp, "de/back.json"), JSON.stringify([{ id: open_id, back: "Offen %@", note: "" }]));
    writeFileSync(join(tmp, "de/back2.json"), JSON.stringify([{ id: open_id, back: "Open %@", note: "ok" }]));
    run("compare-input", "--dir", tmp, "--langs", "de,ja", "--out", join(tmp, "cmp.json"));
    // %lld Kern 没有回译：不进比对输入，并提示
    const cmp = run("compare-input", "--dir", tmp, "--langs", "de,ja", "--out", join(tmp, "cmp.json"));
    expect(json(join(tmp, "cmp.json"))).toEqual([{ id: "de|Localizable|Open %@|", en: "Open %@", back: "Open %@", note: "ok" }]);
    expect(cmp.out).toContain("缺少回译：Localizable|%lld Cores|plural/one");
    expect(cmp.out).toContain("ja：没有 export.json，跳过");
    // 映射写在 proposal 的目录，记录送去回译时的译文
    expect(Object.values(json(join(tmp, "de/back-ids.json")))).toContainEqual({ id: "Localizable|Open %@|", text: "%@ öffnen" });
  });

  test("back-input：映射放在 proposal 目录，输出放在别处也能找到；回译后改过的条目视为过期", () => {
    run("export", "--lang", "de", "--out", join(tmp, "de/export.json"));
    const proposal = (text) =>
      writeFileSync(join(tmp, "de/proposal.json"), JSON.stringify({ lang: "de", changes: [{ id: "Localizable|Open %@|", old: "%@ offnen", new: text, type: "不通顺" }] }));
    proposal("%@ öffnen");
    run("back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, "elsewhere/in.json"));
    const [{ id }] = json(join(tmp, "elsewhere/in.json"));
    writeFileSync(join(tmp, "de/back.json"), JSON.stringify([{ id, back: "Open %@", note: "" }, { id: "bunknown", back: "x" }]));
    const ok = run("compare-input", "--dir", tmp, "--langs", "de", "--out", join(tmp, "cmp.json"));
    expect(json(join(tmp, "cmp.json"))).toHaveLength(1);
    expect(ok.out).toContain("未知的回译 id");

    // 改稿代理在回译后又改了译文：旧回译作废，比对输入不含它，报告标为过期
    proposal("%@ aufmachen");
    const stale = run("compare-input", "--dir", tmp, "--langs", "de", "--out", join(tmp, "cmp.json"));
    expect(json(join(tmp, "cmp.json"))).toEqual([]);
    expect(stale.out).toContain("回译已过期（译文改过）：Localizable|Open %@|");
    writeFileSync(join(tmp, "compare.json"), "[]");
    run("report", "--dir", tmp, "--langs", "de", "--out", join(tmp, "r.html"));
    expect(readFileSync(join(tmp, "r.html"), "utf8")).toContain('"back":"Open %@","note":"回译已过期：译文在回译后改过"');

    // 重新回译后，新编号对应新译文
    run("back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, "de/back2-input.json"));
    const [{ id: id2 }] = json(join(tmp, "de/back2-input.json"));
    expect(id2).not.toBe(id);
    writeFileSync(join(tmp, "de/back2.json"), JSON.stringify([{ id: id2, back: "Open up %@", note: "" }]));
    run("compare-input", "--dir", tmp, "--langs", "de", "--out", join(tmp, "cmp.json"));
    expect(json(join(tmp, "cmp.json"))).toEqual([{ id: "de|Localizable|Open %@|", en: "Open %@", back: "Open up %@", note: "" }]);
  });

  test("back-input：--ids-file 有不匹配的 id 时警告，全部不匹配时失败", () => {
    writeFileSync(join(tmp, "de/proposal.json"), JSON.stringify({ lang: "de", approved: [{ id: "Localizable|Close|", value: "Schließen" }] }));
    const args = (f) => ["back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, "de/in.json"), "--ids-file", f];
    writeFileSync(join(tmp, "ids.json"), JSON.stringify(["de|Localizable|Close|", "Localizable|Gone|"]));
    const partial = run(...args(join(tmp, "ids.json")));
    expect(partial.code).toBe(0);
    expect(partial.out).toContain("1 条不在 proposal");
    writeFileSync(join(tmp, "none.json"), JSON.stringify(["ja|Localizable|Close|"]));
    expect(run(...args(join(tmp, "none.json"))).code).toBe(1);
  });

  test("report：没有 compare.json 时警告", () => {
    writeFileSync(join(tmp, "de/proposal.json"), JSON.stringify({ lang: "de" }));
    const res = run("report", "--dir", tmp, "--langs", "de", "--out", join(tmp, "r.html"));
    expect(res.code).toBe(0);
    expect(res.out).toContain("没有 " + join(tmp, "compare.json"));
  });

  test("apply：重复 id、空译文、结构错误时整体拒绝，退出码 2", () => {
    const before = readFileSync(join(root, CATALOG_PATHS.Localizable), "utf8"),
      tryApply = (p) => {
        writeFileSync(join(tmp, "de/p.json"), JSON.stringify({ lang: "de", ...p }));
        return run("apply", "--lang", "de", "--proposal", join(tmp, "de/p.json"));
      };
    const dup = tryApply({
      changes: [{ id: "Localizable|Open %@|", old: "%@ offnen", new: "%@ öffnen", type: "不通顺" }],
      approved: [{ id: "Localizable|Open %@|", value: "%@ offnen" }],
    });
    expect(dup.code).toBe(2);
    expect(dup.out).toContain("同时出现在 changes 和 approved");
    const empty = tryApply({ changes: [{ id: "Localizable|Open %@|", old: "%@ offnen", new: "  ", type: "不通顺" }] });
    expect(empty.code).toBe(2);
    expect(empty.out).toContain("new 必须是非空字符串");
    expect(tryApply({ changes: "x" }).code).toBe(2);
    expect(tryApply({ changes: [{ id: "bad", old: "a", new: "b", type: "不通顺" }] }).out).toContain("id 格式不对");
    expect(tryApply({ changes: [{ id: "Localizable|Close|", old: "Schließen", new: "Zu", type: "风格" }] }).out).toContain("type 必须是");
    // 带语言前缀的 id 表名不对，不能绕过重复检查
    const prefixed = tryApply({ approved: [{ id: "Localizable|Close|", value: "Schließen" }], doubts: [{ id: "de|Localizable|Close|", question: "q" }] });
    expect(prefixed.out).toContain("id 的表名不对");
    expect(tryApply({ changes: [{ id: "Localizable|Close|", old: "Schließen", new: "Schließen", type: "不通顺" }] }).out).toContain("新旧译文相同");
    expect(tryApply({ withdrawn: [{ id: "Localizable|Close|" }] }).out).toContain("缺少 reason");
    expect(tryApply({ source_issues: [{ id: "Localizable|Close|" }] }).out).toContain("必须有 id 和 problem");
    expect(readFileSync(join(root, CATALOG_PATHS.Localizable), "utf8")).toBe(before);
  });

  test("apply：遵守例外清单，与 check.js 一致", () => {
    const cat = catalog();
    cat.strings.Windows = { localizations: { de: unit("Windows", "needs_review") } };
    writeCatalog(join(root, CATALOG_PATHS.Localizable), cat);
    writeFileSync(join(tmp, "de/p.json"), JSON.stringify({ lang: "de", changes: [{ id: "Localizable|Windows|", old: "Windows", new: "Fensterliste", type: "语义错误" }] }));
    expect(run("apply", "--lang", "de", "--proposal", join(tmp, "de/p.json")).out).toContain("缺少专有名词 Windows");
    writeFileSync(join(root, "i18n/check-exceptions.json"), JSON.stringify([{ table: "Localizable", key: "Windows", rule: "term:Windows", reason: "窗口列表" }]));
    expect(run("apply", "--lang", "de", "--proposal", join(tmp, "de/p.json")).code).toBe(0);
    expect(catalog().strings.Windows.localizations.de).toEqual(unit("Fensterliste"));
  });

  test("apply：只写有改动的 catalog", () => {
    const info = join(root, CATALOG_PATHS.InfoPlist);
    writeFileSync(info, '{"sourceLanguage":"en","strings":{},"version":"1.0"}');
    writeFileSync(join(tmp, "de/p.json"), JSON.stringify({ lang: "de", approved: [{ id: "Localizable|Close|", value: "Schließen" }] }));
    expect(run("apply", "--lang", "de", "--proposal", join(tmp, "de/p.json")).code).toBe(0);
    expect(readFileSync(info, "utf8")).toBe('{"sourceLanguage":"en","strings":{},"version":"1.0"}');
  });

  test("export：未知语言、非法 --limit、非法正则时退出码 2；输出目录不存在时自动创建", () => {
    expect(run("export", "--lang", "xx", "--out", join(tmp, "a.json")).code).toBe(2);
    expect(run("export", "--lang", "de", "--limit", "0", "--out", join(tmp, "a.json")).code).toBe(2);
    expect(run("export", "--lang", "de", "--limit", "abc", "--out", join(tmp, "a.json")).code).toBe(2);
    expect(run("export", "--lang", "de", "--key", "(", "--out", join(tmp, "a.json")).code).toBe(2);
    expect(run("export", "--lang", "de", "--table", "Nope", "--out", join(tmp, "a.json")).code).toBe(2);
    expect(run("export", "--lang", "de", "--out", join(tmp, "new/dir/a.json")).code).toBe(0);
  });

  test("report：跳过没有 proposal 的语言；列出比对结论和撤回的条目", () => {
    run("export", "--lang", "de", "--out", join(tmp, "de/export.json"));
    writeFileSync(
      join(tmp, "de/proposal.json"),
      JSON.stringify({ lang: "de", withdrawn: [{ id: "Localizable|Open %@|", reason: "2 轮后仍有分歧" }] }),
    );
    writeFileSync(join(tmp, "compare.json"), JSON.stringify([{ id: "de|Localizable|Open %@|", type: "意思不同", problem: "p" }]));
    const res = run("report", "--dir", tmp, "--langs", "de,ja", "--out", join(tmp, "r.html"));
    expect(res.code).toBe(0);
    expect(res.out).toContain("ja：没有 proposal.json");
    const html = readFileSync(join(tmp, "r.html"), "utf8");
    expect(html).toContain('"withdrawn":[{"id":"Localizable|Open %@|","reason":"2 轮后仍有分歧","en":"Open %@","current":"%@ offnen"}]');
    // 导出了但 proposal 没有列出的条目，单独列为没有处理
    expect(html).toContain('"unhandled":[{"id":"Localizable|%lld Cores|plural/one","en":"%lld Cores","current":"%lld Kern"},{"id":"Localizable|%lld Cores|plural/other"');
    expect(html).toContain('"mismatches":[{"id":"Localizable|Open %@|","type":"意思不同","problem":"p","en":"Open %@"}]');
  });

  test("report：生成 HTML，数据中的 < 被转义", () => {
    run("export", "--lang", "de", "--out", join(tmp, "de/export.json"));
    writeFileSync(
      join(tmp, "de/proposal.json"),
      JSON.stringify({
        lang: "de",
        changes: [{ id: "Localizable|Open %@|", old: "%@ offnen", new: "<b>%@</b> öffnen", type: "不通顺", reason: "r" }],
        doubts: [{ id: "x", current: "y", question: "z" }],
      }),
    );
    writeFileSync(join(tmp, "de/back.json"), "[]");
    expect(run("report", "--dir", tmp, "--langs", "de", "--out", join(tmp, "r.html")).code).toBe(0);
    const html = readFileSync(join(tmp, "r.html"), "utf8");
    expect(html).toContain("<title>UTM 译文审校</title>");
    expect(html).not.toContain("<b>%@</b>");
    expect(html).toContain("\\u003cb>%@\\u003c/b>");
  });

  test("未知子命令或缺少参数时退出码 2", () => {
    expect(run("nope").code).toBe(2);
    expect(run("export", "--lang", "de").code).toBe(2);
  });
});
