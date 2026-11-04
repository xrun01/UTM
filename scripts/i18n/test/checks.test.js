import { describe, expect, test } from "bun:test";
import { catalogIssuesOf, exceptionMatcherOf, lengthIssueOf, sourceTextAt, unitIssuesOf } from "../lib/checks.js";
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
    const [issue] = catalogIssuesOf("T", catalog, { langs: ["ru"], known });
    expect(issue.level).toBe("warn");
    expect(issue.msg).toContain("few、many");
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
