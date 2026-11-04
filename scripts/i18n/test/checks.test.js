import { describe, expect, test } from "bun:test";
import { catalogIssuesOf, exceptionMatcherOf, exceptionProblemsOf, lengthIssueOf, sourceTextAt, unitIssuesOf } from "../lib/checks.js";
import { termIssuesOf } from "../lib/terms.js";

const rulesOf = (lang, src, value) => unitIssuesOf(lang, src, value).map((i) => i.rule);

describe("unitIssuesOf", () => {
  test("合格的译文没有问题", () => {
    expect(rulesOf("de", "Copy %@ to %@…", "%1$@ nach %2$@ kopieren…")).toEqual([]);
    expect(rulesOf("zh-Hans", "Open UTM", "打开 UTM")).toEqual([]);
  });

  test("换行数不同", () => expect(rulesOf("de", "A:\n%@", "A: %@")).toContain("newline"));

  test("首尾空白不同", () => {
    expect(rulesOf("de", "• ", "•")).toContain("edge-space");
    expect(rulesOf("de", "x", " x")).toContain("edge-space");
  });

  test("省略号被改写", () => expect(rulesOf("pl", "Add…", "Dodaj...")).toContain("ellipsis"));

  test("零宽字符：泰语等允许 U+200B，其他语言不允许；BOM 一律不允许", () => {
    expect(rulesOf("de", "ab", "a\u200bb")).toContain("invisible");
    expect(rulesOf("th", "ab", "a\u200bb")).not.toContain("invisible");
    expect(rulesOf("th", "ab", "a\ufeffb")).toContain("invisible");
  });

  test("变体选择符", () => expect(rulesOf("zh-HK", "Enable", "啟\u{E0101}用")).toContain("invisible"));

  test("Bidi 控制字符", () => expect(rulesOf("ar", "x", "\u202bx")).toContain("bidi"));

  test("非中日韩语言的全角标点和残留汉字", () => {
    expect(rulesOf("ar", "Error: %@", "خطأ：%@")).toContain("fullwidth");
    expect(rulesOf("fr", "Disk", "Disque 磁盘")).toContain("cjk-leftover");
    expect(rulesOf("ja", "Error: %@", "エラー：%@")).toEqual([]);
  });

  test("数字：英文的数字必须出现在译文中，译文可以多出数字", () => {
    expect(rulesOf("ar", "Trackpad (macOS 13+)", "لوحة (macOS 14+)")).toContain("digits");
    expect(rulesOf("ja", "One or more", "1つ以上")).not.toContain("digits");
    expect(rulesOf("ar", "macOS 13+", "macOS ١٣+")).not.toContain("digits");
    expect(rulesOf("de", "%1$@ of %2$@", "%1$@ von %2$@")).not.toContain("digits");
  });

  test("繁简通用字和异体字不算简体字", () => {
    for (const [lang, v] of [["zh-Hant", "批准"], ["zh-Hant", "公里"], ["zh-Hant", "干擾"], ["zh-Hant", "皇后"], ["zh-Hant", "裏面"], ["zh-HK", "峰值"], ["zh-HK", "准許"]]) {
      expect(rulesOf(lang, "x", v)).not.toContain("simplified");
    }
  });

  test("emoji 的 U+FE0F 在英文中也有时不报错；译文多出时报错", () => {
    expect(rulesOf("de", "Warning \u26a0\ufe0f", "Warnung \u26a0\ufe0f")).toEqual([]);
    expect(rulesOf("de", "Warning \u26a0", "Warnung \u26a0\ufe0f")).toContain("invisible");
  });

  test("Bidi 隔离符：从右到左的语言允许，其他语言不允许；嵌入符一律不允许", () => {
    expect(rulesOf("ar", "Copy %@", "نسخ \u2068%@\u2069")).not.toContain("bidi");
    expect(rulesOf("de", "Copy %@", "\u2068%@\u2069 kopieren")).toContain("bidi");
    expect(rulesOf("ar", "Copy %@", "\u202bنسخ %@")).toContain("bidi");
  });

  test("全角括号；英文本来就有全角标点时不报", () => {
    expect(rulesOf("pl", "%@ (%@)", "%1$@（%2$@）")).toContain("fullwidth");
    expect(rulesOf("de", "Use （", "Nutze （")).not.toContain("fullwidth");
  });

  test("繁体译文中的简体字；台、游不算", () => {
    expect(rulesOf("zh-HK", "When running", "執行时")).toContain("simplified");
    expect(rulesOf("zh-Hant", "Platform", "平台")).not.toContain("simplified");
    expect(rulesOf("zh-Hant", "Blinking cursor?", "游標正在閃爍？")).not.toContain("simplified");
    expect(rulesOf("zh-Hans", "When running", "执行时")).not.toContain("simplified");
  });

  test("占位符", () => expect(rulesOf("de", "%lld Cores", "Kerne")).toContain("format"));
});

describe("termIssuesOf", () => {
  test("缺少专有名词", () => {
    expect(termIssuesOf("Install Linux", "تثبيت لينكس")).toEqual([{ term: "Linux", msg: "缺少专有名词 Linux" }]);
  });

  test("大小写错误按词边界判断，macOS 中的 mac 不算", () => {
    expect(termIssuesOf("on ARM64", "在 arm64 上")[0].msg).toBe("专有名词大小写错误：应为 ARM64，译文写成 arm64");
    expect(termIssuesOf("Mac Keyboard (macOS 14+)", "Klawiatura (macOS 14+)")[0].msg).toBe("缺少专有名词 Mac");
  });

  test("英文中不是独立单词时不检查：Macs、macOS", () => {
    expect(termIssuesOf("Macs and macOS", "macOS")).toEqual([]);
  });

  test("按词干匹配变格：Rosetta 写成 Rosettę 合格", () => {
    expect(termIssuesOf("Install Rosetta", "Zainstaluj Rosettę")).toEqual([]);
  });
});

test("sourceTextAt：复数类别英文没有时用 other", () => {
  const entry = {
    localizations: {
      en: { variations: { plural: { one: { stringUnit: { value: "%lld Core" } }, other: { stringUnit: { value: "%lld Cores" } } } } },
    },
  };
  expect(sourceTextAt("%lld Cores", entry, ["plural", "one"])).toBe("%lld Core");
  expect(sourceTextAt("%lld Cores", entry, ["plural", "few"])).toBe("%lld Cores");
  expect(sourceTextAt("Hello", {}, [])).toBe("Hello");
});

test("lengthIssueOf：英文少于 10 个字符时不检查；中日韩与其他语言阈值不同", () => {
  expect(lengthIssueOf("de", "USB Devices", "USB")).toContain("0.27");
  expect(lengthIssueOf("de", "USB Device", "USB")).toBeNull();
  expect(lengthIssueOf("de", "Short", "S")).toBeNull();
  expect(lengthIssueOf("zh-Hans", "Dynamic Resolution", "动态")).toContain("0.11");
  expect(lengthIssueOf("zh-Hans", "Dynamic Resolution", "动态分辨率")).toBeNull();
});

describe("catalogIssuesOf", () => {
  const known = new Set(["de", "ja", "ru"]),
    unit = (value) => ({ stringUnit: { state: "translated", value } });

  test("缺译、未知语言、stale、英文含中文、不翻译的键", () => {
    const catalog = {
      strings: {
        A: { localizations: { de: unit("A") } },
        B: { extractionState: "stale", localizations: { de: unit("B") } },
        "中文": {},
        "%@": { shouldTranslate: false },
        C: { localizations: { xx: unit("C"), de: unit("C") } },
      },
    };
    const got = catalogIssuesOf("T", catalog, { langs: ["de"], known }).map((i) => [i.rule, i.key, i.lang]);
    expect(got).toEqual([
      ["stale", "B", null],
      ["source-cjk", "中文", "en"],
      ["missing", "中文", "de"],
      ["unknown-lang", "C", "xx"],
    ]);
  });

  test("复数类别不全时给警告", () => {
    const catalog = {
      strings: {
        "%lld Cores": {
          localizations: { ru: { variations: { plural: { one: unit("%lld ядро"), other: unit("%lld ядра") } } } },
        },
      },
    };
    const issues = catalogIssuesOf("T", catalog, { langs: ["ru"], known });
    expect(issues.map((i) => [i.level, i.rule])).toEqual([["warn", "plural"]]);
    expect(issues[0].msg).toContain("few、many");
  });

  test("英文区分复数、译文只有 1 种形式时给警告；只有 other 的语言不警告", () => {
    const en = { variations: { plural: { one: unit("%lld Core"), other: unit("%lld Cores") } } },
      catalog = { strings: { "%lld Cores": { localizations: { en, ru: unit("%lld ядер"), ja: unit("%lld コア") } } } };
    const got = catalogIssuesOf("T", catalog, { langs: ["ru", "ja"], known: new Set(["ru", "ja"]) });
    expect(got.map((i) => [i.lang, i.rule])).toEqual([["ru", "plural"]]);
  });

  test("标为不翻译的条目：不算缺译，但已有译文照样检查；英文有文字时警告", () => {
    const catalog = {
      strings: {
        "%@ (%@)": { shouldTranslate: false, localizations: { de: unit("%1$@（%2$@）") } },
        UTM: { shouldTranslate: false },
      },
    };
    const got = catalogIssuesOf("T", catalog, { langs: ["de"], known }).map((i) => [i.key, i.rule]);
    expect(got).toEqual([
      ["%@ (%@)", "fullwidth"],
      ["UTM", "should-translate"],
    ]);
  });

  test("substitutions 暂不支持，报错", () => {
    const catalog = { strings: { "%#@a@": { localizations: { de: { stringUnit: { value: "x" }, substitutions: {} } } } } };
    expect(catalogIssuesOf("T", catalog, { langs: ["de"], known }).map((i) => i.rule)).toContain("substitutions");
  });

  test("例外的 lang 字段只对这种语言生效", () => {
    const exceptions = exceptionMatcherOf([{ table: "T", key: "Windows", lang: "de", rule: "term:Windows" }]),
      catalog = { strings: { Windows: { localizations: { de: unit("Fenster"), ja: unit("ウインドウ") } } } };
    const got = catalogIssuesOf("T", catalog, { langs: ["de", "ja"], known: new Set(["de", "ja"]), exceptions });
    expect(got.map((i) => [i.lang, i.rule])).toEqual([["ja", "term:Windows"]]);
  });

  test("例外清单：命中的问题被跳过，没有命中的例外可以查出来", () => {
    const exceptions = exceptionMatcherOf([
      { table: "T", key: "Windows", rule: "term:Windows" },
      { table: "T", key: "X", rule: "term:Windows" },
    ]);
    const catalog = { strings: { Windows: { localizations: { de: unit("Fenster") } } } },
      got = catalogIssuesOf("T", catalog, { langs: ["de"], known, exceptions });
    expect(got).toEqual([]);
    expect(exceptions.unused().map((e) => e.key)).toEqual(["X"]);
  });
});

test("exceptionProblemsOf：校验 rule、reason 和必填字段", () => {
  expect(exceptionProblemsOf([{ table: "T", key: "K", rule: "term:Windows", reason: "窗口" }])).toEqual([]);
  expect(exceptionProblemsOf([{ file: "a.swift", text: "中", rule: "source-cjk-literal", reason: "语言名" }])).toEqual([]);
  const got = exceptionProblemsOf([
    { table: "T", key: "K", rule: "length", reason: "x" },
    { table: "T", key: "K", rule: "format", reason: " " },
    { rule: "format", reason: "x" },
    { file: "a.swift", rule: "source-cjk-literal", reason: "x" },
  ]);
  expect(got).toEqual([
    "第 1 条：rule 不是可以写例外的规则: length",
    "第 2 条：缺少 reason",
    "第 3 条：必须写 table 和 key",
    "第 4 条：source-cjk-literal 必须写 file 和 text",
  ]);
  expect(exceptionProblemsOf({})).toEqual(["例外清单必须是数组"]);
});

