import { describe, expect, test } from "bun:test";
import { langIdOf, transportOf } from "../lib/api.js";
import { emptyCatalog } from "../lib/catalog.js";
import { maskOf, unmaskOf } from "../lib/mask.js";
import { deriveLang, pendingOf, polishOf, translateLang } from "../lib/translate.js";

describe("maskOf / unmaskOf", () => {
  const roundTrip = (source, translated) => unmaskOf(maskOf(source), translated);

  test("占位符换成 {n}，%% 换成 %", () => {
    expect(maskOf("Copy %@ to %@ (%lld%%)").text).toBe("Copy {1} to {2} ({3}%)");
  });

  test("顺序不变时还原成原写法", () => {
    expect(roundTrip("Copy %@ to %@?", "复制 {1} 到 {2}？")).toBe("复制 %@ 到 %@？");
  });

  test("顺序调换时改成带序号的写法", () => {
    expect(roundTrip("Failed to open %@ because %@.", "由于 {2}，无法打开 {1}。")).toBe("由于 %2$@，无法打开 %1$@。");
  });

  test("原文本来就带序号时保持带序号", () => {
    expect(roundTrip("%1$@ (%2$@)", "{1}（{2}）")).toBe("%1$@（%2$@）");
  });

  test("格式文案中的字面量 % 转义成 %%；不是格式文案时不转义", () => {
    expect(roundTrip("%lld%% done", "{1} % erledigt")).toBe("%lld %% erledigt");
    expect(roundTrip("No format here", "100 % ok")).toBe("100 % ok");
  });

  test("占位符缺失或多出时返回 null", () => {
    expect(roundTrip("%@ and %@", "{1}")).toBeNull();
    expect(roundTrip("%@", "{1} {2}")).toBeNull();
  });

  test("同一个参数出现 2 次时改成带序号的写法", () => {
    expect(roundTrip("%@", "{1}（{1}）")).toBe("%1$@（%1$@）");
  });

  test("不支持 stringsdict 变量和字面量 {数字}", () => {
    expect(maskOf("%#@cores@")).toBeNull();
    expect(maskOf("Use {1} literally")).toBeNull();
  });
});

describe("polishOf", () => {
  test("还原省略号、首尾空白，删除不可见字符", () => {
    expect(polishOf("de", "Add…", "Hinzufügen...")).toBe("Hinzufügen…");
    expect(polishOf("de", "• ", "•")).toBe("• ");
    expect(polishOf("de", "a", "\u200ba\ufeff")).toBe("a");
    expect(polishOf("th", "a", "a\u200bb")).toBe("a\u200bb");
  });

  test("非中日韩语言的全角标点和括号换成半角", () => {
    expect(polishOf("ar", "Error: %@", "خطأ：%@")).toBe("خطأ: %@");
    expect(polishOf("ja", "Error: %@", "エラー：%@")).toBe("エラー：%@");
    expect(polishOf("pl", "%@ (%@)", "%1$@（%2$@）")).toBe("%1$@ (%2$@)");
    expect(polishOf("pl", "A (B)", "A （B）")).toBe("A (B)");
  });

  test("保留英文中也有的变体选择符；从右到左的语言保留 Bidi 隔离符", () => {
    expect(polishOf("de", "Warning \u26a0\ufe0f", "Warnung \u26a0\ufe0f")).toBe("Warnung \u26a0\ufe0f");
    expect(polishOf("de", "Warning", "Warnung\ufe0f")).toBe("Warnung");
    expect(polishOf("ar", "Copy %@", "نسخ \u2068%@\u2069")).toBe("نسخ \u2068%@\u2069");
    expect(polishOf("de", "Copy %@", "\u2068%@\u2069 kopieren")).toBe("%@ kopieren");
  });
});

describe("transportOf", () => {
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

  test("没有 token 时报错", () => expect(() => transportOf(null)).toThrow("token"));

  test("请求体是 [from_id, to_id, path, text]，返回译文全文", async () => {
    let sent;
    const t = transportOf("T", {
      fetchFn: async (url, init) => {
        sent = { url, init };
        return ok(["k1: \"你好\"", 42]);
      },
    });
    expect(await t("en", "zh", "p.yml", "k1: \"Hi\"")).toBe('k1: "你好"');
    expect(sent.init.headers.token).toBe("T");
    expect(JSON.parse(sent.init.body)).toEqual([langIdOf("en"), langIdOf("zh"), "p.yml", 'k1: "Hi"']);
  });

  test("5xx 重试，4xx 不重试", async () => {
    let n = 0;
    const flaky = transportOf("T", { retries: 2, fetchFn: async () => (++n < 2 ? new Response("", { status: 502 }) : ok(["x", 1])) });
    expect(await flaky("en", "de", "p", "x")).toBe("x");
    expect(n).toBe(2);

    let m = 0;
    const denied = transportOf("T", { retries: 2, fetchFn: async () => (++m, new Response("no", { status: 403 })) });
    await expect(denied("en", "de", "p", "x")).rejects.toThrow("403");
    expect(m).toBe(1);
  });

  test("不支持的语言代码", () => expect(() => langIdOf("xx")).toThrow("不支持"));
});

// 模拟接口：按 YAML 行把英文换成 dict 中的译文，不在 dict 中的原样返回
const fakeTransport = (dict, log = []) => async (from, to, path, yaml) => {
  log.push(yaml);
  return yaml
    .split("\n")
    .map((line) => {
      const m = line.match(/^(k[0-9a-f]+): (".*")$/);
      if (!m) return line;
      const text = JSON.parse(m[2]);
      return m[1] + ": " + JSON.stringify(dict[text] ?? text);
    })
    .join("\n");
};

const catalogsOf = (strings) => ({ Localizable: { ...emptyCatalog(), strings } });

describe("translateLang", () => {
  test("只翻译缺译条目，已有译文不动，写入的状态是 needs_review", async () => {
    const catalogs = catalogsOf({
      Hello: { localizations: { de: { stringUnit: { state: "translated", value: "Hallo (geprüft)" } } } },
      World: {},
      "%@": { shouldTranslate: false },
    });
    const log = [],
      report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport: fakeTransport({ World: "Welt" }, log) });
    expect(report.written).toBe(1);
    expect(catalogs.Localizable.strings.Hello.localizations.de.stringUnit).toEqual({ state: "translated", value: "Hallo (geprüft)" });
    expect(catalogs.Localizable.strings.World.localizations.de.stringUnit).toEqual({ state: "needs_review", value: "Welt" });
    expect(log.join("")).not.toContain("Hello");
  });

  test("占位符还原，顺序调换时改成带序号的写法", async () => {
    const catalogs = catalogsOf({ "Failed to open %@ because %@.": {} });
    await translateLang({
      catalogs,
      lang: "zh-Hans",
      api_lang: "zh",
      transport: fakeTransport({ "Failed to open {1} because {2}.": "由于 {2}，无法打开 {1}。" }),
    });
    expect(catalogs.Localizable.strings["Failed to open %@ because %@."].localizations["zh-Hans"].stringUnit.value).toBe(
      "由于 %2$@，无法打开 %1$@。",
    );
  });

  test("不合格的译文不写入：音译了专有名词", async () => {
    const catalogs = catalogsOf({ "Install Linux": {} });
    const report = await translateLang({ catalogs, lang: "ar", api_lang: "ar", transport: fakeTransport({ "Install Linux": "تثبيت لينكس" }) });
    expect(report.written).toBe(0);
    expect(report.failed[0].reason).toContain("缺少专有名词 Linux");
    expect(catalogs.Localizable.strings["Install Linux"].localizations).toBeUndefined();
  });

  test("不同表中的相同原文只发送 1 行", async () => {
    const catalogs = {
        Localizable: { ...emptyCatalog(), strings: { Hello: {} } },
        InfoPlist: { ...emptyCatalog(), strings: { K: { localizations: { en: { stringUnit: { state: "new", value: "Hello" } } } } } },
      },
      log = [];
    const report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport: fakeTransport({ Hello: "Hallo" }, log) });
    expect(report.written).toBe(2);
    expect(log).toHaveLength(1);
    expect(log[0].trim().split("\n")).toHaveLength(1);
  });

  test("接口漏掉的条目单独重试 1 次", async () => {
    const catalogs = catalogsOf({ A: {}, B: {} }),
      sent = [];
    // 第 1 次请求时接口漏掉 B 的译文
    const transport = async (...args) => {
      sent.push(args[3]);
      const out = await fakeTransport({ A: "a", B: "b" })(...args);
      return sent.length === 1 ? out.split("\n").filter((l) => !l.includes('"b"')).join("\n") : out;
    };
    const report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport });
    expect(report.written).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('"B"');
    expect(sent[1]).not.toContain('"A"');
  });

  test("复数：按目标语言的每个类别用示例数字翻译；没有整数示例的类别复制 many", async () => {
    const plural = (one, other) => ({
      variations: { plural: { one: { stringUnit: { state: "new", value: one } }, other: { stringUnit: { state: "new", value: other } } } },
    });
    const catalogs = catalogsOf({ "%lld Cores": { localizations: { en: plural("%lld Core", "%lld Cores") } } });
    const report = await translateLang({
      catalogs,
      lang: "ru",
      api_lang: "ru",
      transport: fakeTransport({ "1 Core": "1 ядро", "2 Cores": "2 ядра", "0 Cores": "0 ядер" }),
    });
    const ru = catalogs.Localizable.strings["%lld Cores"].localizations.ru.variations.plural;
    expect(Object.fromEntries(Object.entries(ru).map(([k, v]) => [k, v.stringUnit.value]))).toEqual({
      one: "%lld ядро",
      few: "%lld ядра",
      many: "%lld ядер",
      other: "%lld ядер",
    });
    expect(report.written).toBe(4);
  });

  test("复数：只补缺少的类别", async () => {
    const unit = (value, state = "translated") => ({ stringUnit: { state, value } });
    const catalogs = catalogsOf({
      "%lld Cores": {
        localizations: {
          en: { variations: { plural: { one: unit("%lld Core", "new"), other: unit("%lld Cores", "new") } } },
          ru: { variations: { plural: { one: unit("%lld ядро"), other: unit("%lld ядра") } } },
        },
      },
    });
    const skipped = [];
    expect(pendingOf(catalogs, "ru", skipped).map((u) => u.path[1])).toEqual(["few", "many"]);
  });
});

test("deriveLang：zh-HK 由 zh-Hant 转换，只补缺失的单元", () => {
  const unit = (value, state = "translated") => ({ stringUnit: { state, value } });
  const catalogs = catalogsOf({
    A: { localizations: { "zh-Hant": unit("啟動虛擬機"), "zh-HK": unit("已有") } },
    B: { localizations: { "zh-Hant": unit("裡面") } },
    C: {},
  });
  const report = deriveLang({ catalogs, lang: "zh-HK", derive: { from: "zh-Hant", opencc: "tw-hk" } });
  expect(report.written).toBe(1);
  expect(catalogs.Localizable.strings.A.localizations["zh-HK"].stringUnit.value).toBe("已有");
  expect(catalogs.Localizable.strings.B.localizations["zh-HK"].stringUnit).toEqual({ state: "needs_review", value: "裏面" });
  expect(catalogs.Localizable.strings.C.localizations).toBeUndefined();
});
