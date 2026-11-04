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
          { id: "Localizable|Close|", old: "Schliessen", new: "Zu" },
          { id: "Localizable|Open %@|", old: "%@ offnen", new: "öffnen" },
          { id: "Localizable|Gone|", old: "x", new: "y" },
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

  test("apply：proposal 的语言不一致时拒绝", () => {
    writeFileSync(join(tmp, "de/proposal.json"), JSON.stringify({ lang: "ja", changes: [] }));
    expect(run("apply", "--lang", "de", "--proposal", join(tmp, "de/proposal.json")).code).toBe(1);
  });

  test("back-input 与 compare-input：后一轮回译覆盖前一轮", () => {
    run("export", "--lang", "de", "--out", join(tmp, "de/export.json"));
    writeFileSync(
      join(tmp, "de/proposal.json"),
      JSON.stringify({
        lang: "de",
        changes: [{ id: "Localizable|Open %@|", old: "%@ offnen", new: "%@ öffnen" }],
        approved: [{ id: "Localizable|%lld Cores|plural/one", value: "%lld Kern" }],
      }),
    );
    run("back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, "de/back-input.json"));
    expect(json(join(tmp, "de/back-input.json"))).toEqual([
      { id: "Localizable|Open %@|", text: "%@ öffnen" },
      { id: "Localizable|%lld Cores|plural/one", text: "%lld Kern" },
    ]);
    run("back-input", "--proposal", join(tmp, "de/proposal.json"), "--out", join(tmp, "de/b2.json"), "--ids", "Localizable|Open %@|");
    expect(json(join(tmp, "de/b2.json"))).toHaveLength(1);

    writeFileSync(join(tmp, "de/back.json"), JSON.stringify([{ id: "Localizable|Open %@|", back: "Offen %@", note: "" }]));
    writeFileSync(join(tmp, "de/back2.json"), JSON.stringify([{ id: "Localizable|Open %@|", back: "Open %@", note: "ok" }]));
    run("compare-input", "--dir", tmp, "--langs", "de", "--out", join(tmp, "cmp.json"));
    expect(json(join(tmp, "cmp.json"))).toEqual([{ id: "de|Localizable|Open %@|", en: "Open %@", back: "Open %@", note: "ok" }]);
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
