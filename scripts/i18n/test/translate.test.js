import { describe, expect, test } from "bun:test";
import { FatalError, langIdOf, transportOf } from "../lib/api.js";
import { emptyCatalog } from "../lib/catalog.js";
import { exceptionMatcherOf } from "../lib/checks.js";
import { maskOf, unmaskOf } from "../lib/mask.js";
import { deriveLang, integerSampleOf, isShortLabel, parseYaml, pendingOf, polishOf, translateLang, yamlOf } from "../lib/translate.js";

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
      "Welcome to UTM": {},
      "%@": { shouldTranslate: false },
    });
    const log = [],
      report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport: fakeTransport({ "Welcome to UTM": "Willkommen bei UTM" }, log) });
    expect(report.written).toBe(1);
    expect(catalogs.Localizable.strings.Hello.localizations.de.stringUnit).toEqual({ state: "translated", value: "Hallo (geprüft)" });
    expect(catalogs.Localizable.strings["Welcome to UTM"].localizations.de.stringUnit).toEqual({ state: "needs_review", value: "Willkommen bei UTM" });
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
    const catalogs = catalogsOf({ "Install Linux now": {} });
    const report = await translateLang({ catalogs, lang: "ar", api_lang: "ar", transport: fakeTransport({ "Install Linux now": "تثبيت لينكس الآن" }) });
    expect(report.written).toBe(0);
    expect(report.failed[0].reason).toContain("缺少专有名词 Linux");
    expect(catalogs.Localizable.strings["Install Linux now"].localizations).toBeUndefined();
  });

  test("不同表中的相同原文只发送 1 行", async () => {
    const catalogs = {
        Localizable: { ...emptyCatalog(), strings: { "Hello there friend": {} } },
        InfoPlist: { ...emptyCatalog(), strings: { K: { localizations: { en: { stringUnit: { state: "new", value: "Hello there friend" } } } } } },
      },
      log = [];
    const report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport: fakeTransport({ "Hello there friend": "Hallo Freund" }, log) });
    expect(report.written).toBe(2);
    expect(log).toHaveLength(1);
    expect(log[0].trim().split("\n")).toHaveLength(1);
  });

  test("接口漏掉的条目单独重试 1 次", async () => {
    const catalogs = catalogsOf({ "Alpha beta gamma": {}, "Delta epsilon zeta": {} }),
      sent = [];
    // 第 1 次请求时接口漏掉第 2 条的译文
    const transport = async (...args) => {
      sent.push(args[3]);
      const out = await fakeTransport({ "Alpha beta gamma": "Alfa Beta Gamma", "Delta epsilon zeta": "Delta Epsilon Zeta" })(...args);
      return sent.length === 1 ? out.split("\n").filter((l) => !l.includes('"Delta Epsilon Zeta"')).join("\n") : out;
    };
    const report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport });
    expect(report.written).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('"Delta epsilon zeta"');
    expect(sent[1]).not.toContain('"Alpha beta gamma"');
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
      // ru 的 one 优先选 21：21 在英文里属于 other，送去翻译的就是 check.js 对照的英文 other
      transport: fakeTransport({ "21 Cores": "21 ядро", "2 Cores": "2 ядра", "5 Cores": "5 ядер" }),
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
    const { units, copies } = pendingOf(catalogs, "ru", skipped);
    expect(units.map((u) => u.path[1])).toEqual(["few", "many"]);
    expect(copies).toEqual([]);
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

describe("评审修复", () => {
  const unit = (value, state = "translated") => ({ stringUnit: { state, value } }),
    enPlural = () => ({ variations: { plural: { one: unit("%lld Core", "new"), other: unit("%lld Cores", "new") } } });

  test("integerSampleOf：优先 1 至 999，同一类别中优先选英文属于 other 的数", () => {
    expect(integerSampleOf("fr", "one")).toBe(1);
    expect(integerSampleOf("de", "other")).toBe(2);
    expect(integerSampleOf("ja", "other")).toBe(2);
    expect(integerSampleOf("ru", "one")).toBe(21);
    expect(integerSampleOf("ar", "one")).toBe(1);
    expect(integerSampleOf("ar", "zero")).toBe(0);
    expect(integerSampleOf("ru", "other")).toBeNull();
  });

  test("parseYaml：没加引号的值、{ 开头的值、单引号和折叠写法都按 YAML 解析，不把语法写进译文", () => {
    const out = parseYaml(['ka00000000001: {1} jetzt kopieren', "ka00000000002: 'Fehler: schlecht'", "ka00000000003: >-", "  gefaltet", 'ka00000000004: "a" # c'].join("\n"));
    expect(out).toEqual({ ka00000000001: "{1} jetzt kopieren", ka00000000002: "Fehler: schlecht", ka00000000003: "gefaltet", ka00000000004: "a" });
  });

  test("parseYaml：整体解析失败时只取双引号值，其余按缺失处理", () => {
    // 没有闭合的双引号不会被补引号，整份 YAML 解析失败
    const out = parseYaml(['ka00000000001: "ok"', 'ka00000000002: "unterminated'].join("\n"));
    expect(out.ka00000000001).toBe("ok");
    expect(out.ka00000000002).toBeUndefined();
  });

  test("yamlOf 与 parseYaml 往返：引号、反斜杠、换行、制表、冒号、井号、emoji、阿拉伯文", () => {
    const items = ['say "hi"', "back\\slash", "a\nb", "tab\there", "key: value", "# not comment", "- dash", "😀", "خطأ: %@"].map((text, i) => ({ id: "k" + String(i).padStart(12, "0"), text }));
    const out = parseYaml(yamlOf(items));
    for (const it of items) expect(out[it.id]).toBe(it.text);
  });

  test("复制复数：来源固定为 many，many 失败时不退回 one；原来没有复数的键整键不写", async () => {
    const catalogs = catalogsOf({ "%lld Cores": { localizations: { en: enPlural() } } });
    // many 的译文丢了示例数字，不合格
    const report = await translateLang({
      catalogs,
      lang: "ru",
      api_lang: "ru",
      transport: fakeTransport({ "21 Cores": "21 ядро", "2 Cores": "2 ядра", "5 Cores": "пять ядер" }),
    });
    expect(catalogs.Localizable.strings["%lld Cores"].localizations.ru).toBeUndefined();
    const reasons = report.failed.map((f) => f.reason).join("\n");
    expect(reasons).toContain("复数类别 other 的来源 many 没有译文");
    expect(reasons).toContain("同一个键的其他复数类别失败，整键不写入");
    expect(report.written).toBe(0);
  });

  test("--limit：没处理到的复数键不复制，也不报失败", async () => {
    const catalogs = catalogsOf({ "Alpha beta gamma": {}, "%lld Cores": { localizations: { en: enPlural() } } });
    const report = await translateLang({ catalogs, lang: "ru", api_lang: "ru", transport: fakeTransport({ "Alpha beta gamma": "Альфа бета гамма" }), limit: 1 });
    expect(report.written).toBe(1);
    expect(report.failed).toEqual([]);
  });

  test("deriveLang：zh-HK 已有复数译文时不被整体覆盖", () => {
    const catalogs = catalogsOf({
      K: { localizations: { "zh-Hant": unit("核心"), "zh-HK": { variations: { plural: { other: unit("人工") } } } } },
    });
    expect(deriveLang({ catalogs, lang: "zh-HK", derive: { from: "zh-Hant", opencc: "tw-hk" } }).written).toBe(0);
    expect(catalogs.Localizable.strings.K.localizations["zh-HK"].variations.plural.other.stringUnit.value).toBe("人工");
  });

  test("FatalError 中止整次运行，不逐条重发", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      throw new FatalError("翻译接口返回 403");
    };
    await expect(translateLang({ catalogs: catalogsOf({ "Alpha beta gamma": {}, "Delta epsilon zeta": {} }), lang: "de", api_lang: "de", transport })).rejects.toThrow("403");
    expect(calls).toBe(1);
  });

  test("部分批次失败：失败的那批不逐条重发，其余批次照常写入", async () => {
    const strings = Object.fromEntries(Array.from({ length: 151 }, (_, i) => ["Sample text " + i + " here", {}]));
    let calls = 0;
    const transport = async (f, to, p, yaml) => {
      calls++;
      if (yaml.includes('"Sample text 150 here"')) throw new Error("网络断开");
      return yaml;
    };
    const report = await translateLang({ catalogs: catalogsOf(strings), lang: "de", api_lang: "de", transport });
    expect(calls).toBe(2);
    expect(report.written).toBe(150);
    expect(report.failed).toEqual([{ table: "Localizable", key: "Sample text 150 here", reason: "请求失败: 网络断开" }]);
  });

  test("所有批次都失败时中止整次运行", async () => {
    const transport = async () => {
      throw new Error("网络断开");
    };
    await expect(translateLang({ catalogs: catalogsOf({ "Alpha beta gamma": {}, "Delta epsilon zeta": {} }), lang: "de", api_lang: "de", transport })).rejects.toThrow("所有请求都失败");
  });

  test("重试换一个键，绕开服务端的按行缓存；两次都不合格时保留第 1 次的原因", async () => {
    const sent = [];
    const transport = async (...args) => {
      sent.push(args[3]);
      return fakeTransport({ "Install Linux now": "تثبيت لينكس الآن" })(...args);
    };
    const report = await translateLang({ catalogs: catalogsOf({ "Install Linux now": {} }), lang: "ar", api_lang: "ar", transport });
    expect(sent).toHaveLength(2);
    expect(sent[0].split(":")[0]).not.toBe(sent[1].split(":")[0]);
    expect(report.failed[0].reason).toContain("第 1 次");
  });

  test("带 * 的占位符不送翻译", () => {
    const skipped = [];
    expect(pendingOf(catalogsOf({ "%*d items": {} }), "de", skipped).units).toEqual([]);
    expect(skipped[0].reason).toContain("带 * 的占位符");
  });

  test("transportOf：429 按 Retry-After 重试", async () => {
    let n = 0;
    const t = transportOf("T", {
      retries: 1,
      fetchFn: async () => (++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response(JSON.stringify(["x", 1]))),
    });
    expect(await t("en", "de", "p", "x")).toBe("x");
    expect(n).toBe(2);
  });
});

describe("第 2 轮评审修复", () => {
  const unit = (value, state = "translated") => ({ stringUnit: { state, value } });

  test("parseYaml：多行普通值交给 YAML 解析，不截成第 1 行；CRLF 也能解析", () => {
    expect(parseYaml("ka00000000001: Hallo\n  Welt\nka00000000002: ok\n")).toEqual({ ka00000000001: "Hallo Welt", ka00000000002: "ok" });
    expect(parseYaml('ka00000000001: {1} öffnen\r\nka00000000002: "b"\r\n')).toEqual({ ka00000000001: "{1} öffnen", ka00000000002: "b" });
  });

  test("parseYaml：YAML 特殊值不当作译文", () => {
    expect(parseYaml("ka00000000001: null\nka00000000002: true\nka00000000003: ok\n")).toEqual({ ka00000000003: "ok" });
  });

  test("接口返回 200 但内容中没有任何条目：按整批失败，不逐条重发", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      return "<html>Gateway</html>";
    };
    await expect(translateLang({ catalogs: catalogsOf({ "Alpha beta gamma": {}, "Delta epsilon zeta": {}, "Eta theta iota": {} }), lang: "de", api_lang: "de", transport })).rejects.toThrow(
      "接口返回的内容无法解析为译文",
    );
    expect(calls).toBe(1);
  });

  test("复数：英文 one 写成「One core」时，中日韩语言用 other 的示例数字照样翻译", async () => {
    const en = { variations: { plural: { one: unit("One core", "new"), other: unit("%lld cores", "new") } } },
      catalogs = catalogsOf({ "%lld cores": { localizations: { en } } });
    const report = await translateLang({ catalogs, lang: "ja", api_lang: "ja", transport: fakeTransport({ "2 cores": "2 コア" }) });
    expect(report.written).toBe(1);
    expect(catalogs.Localizable.strings["%lld cores"].localizations.ja.variations.plural.other.stringUnit.value).toBe("%lld コア");
  });

  test("复数：只对应 1 个整数的类别（ar 的 one）可以省略数字", async () => {
    const catalogs = catalogsOf({ "%lld Cores": { localizations: { en: { variations: { plural: { one: unit("%lld Core", "new"), other: unit("%lld Cores", "new") } } } } } });
    const { units } = pendingOf(catalogs, "ar");
    const one = units.find((u) => u.path[1] === "one");
    expect(one.text).toBe("1 Core");
    expect(one.finish("نواة واحدة")).toBe("نواة واحدة");
  });

  test("空译文的失败原因是「译文为空」", async () => {
    const report = await translateLang({ catalogs: catalogsOf({ "Hello there friend": {} }), lang: "de", api_lang: "de", transport: async (f, t, p, y) => y.replace(/: .*/g, ': ""') });
    expect(report.failed[0].reason).toContain("译文为空");
  });

  test("长度异常的机翻不写入", async () => {
    const report = await translateLang({ catalogs: catalogsOf({ "Hello there friend": {} }), lang: "de", api_lang: "de", transport: fakeTransport({ "Hello there friend": "x".repeat(500) }) });
    expect(report.written).toBe(0);
    expect(report.failed[0].reason).toContain("译文长度异常");
  });

  test("复制的类别也要校验：来源是不合格的人工译文时整键不写", async () => {
    const en = { variations: { plural: { one: unit("%lld Core", "new"), other: unit("%lld Cores", "new") } } },
      // 已有的 many 丢了占位符，复制给 other 后不合格
      ru = { variations: { plural: { many: unit("ядер") } } },
      catalogs = catalogsOf({ "%lld Cores": { localizations: { en, ru } } });
    const report = await translateLang({ catalogs, lang: "ru", api_lang: "ru", transport: fakeTransport({ "21 Cores": "21 ядро", "2 Cores": "2 ядра" }) });
    expect(report.failed.some((f) => f.reason.includes("占位符"))).toBe(true);
  });

  test("每次运行的重试 salt 不同，重新运行时不会命中同一个坏缓存", async () => {
    const keysOf = async () => {
      const sent = [];
      await translateLang({
        catalogs: catalogsOf({ "Install Linux now": {} }),
        lang: "ar",
        api_lang: "ar",
        transport: async (...args) => (sent.push(args[3]), fakeTransport({ "Install Linux now": "تثبيت لينكس الآن" })(...args)),
      });
      return sent.map((s) => s.split(":")[0]);
    };
    const a = await keysOf(),
      b = await keysOf();
    expect(a[0]).toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
  });

  test("deriveLang 跳过嵌套的 variations", () => {
    const nested = { variations: { device: { mac: { variations: { plural: { other: unit("核心") } } } } } },
      catalogs = catalogsOf({ K: { localizations: { "zh-Hant": nested } } });
    expect(deriveLang({ catalogs, lang: "zh-HK", derive: { from: "zh-Hant", opencc: "tw-hk" } }).written).toBe(0);
  });

  test("transportOf：报错中的 token 被替换；408 和返回非 JSON 时重试", async () => {
    const leak = transportOf("SECRET", { retries: 0, fetchFn: async () => new Response("bad token SECRET", { status: 401 }) });
    await expect(leak("en", "de", "p", "x")).rejects.toThrow("bad token ***");
    let n = 0;
    const flaky = transportOf("T", {
      retries: 2,
      fetchFn: async () => (++n === 1 ? new Response("", { status: 408 }) : n === 2 ? new Response("<html>") : new Response(JSON.stringify(["ok", 1]))),
    });
    expect(await flaky("en", "de", "p", "x")).toBe("ok");
    expect(n).toBe(3);
  });
});

describe("第 3 轮评审修复", () => {
  const unit = (value, state = "translated") => ({ stringUnit: { state, value } });

  test("parseYaml：以 & ! * 开头的值是普通文字，不被当成锚点或标签吞掉", () => {
    expect(parseYaml("ka00000000001: &x Datei öffnen\nka00000000002: !wichtig Text\nka00000000003: *Pflichtfeld\n")).toEqual({
      ka00000000001: "&x Datei öffnen",
      ka00000000002: "!wichtig Text",
      ka00000000003: "*Pflichtfeld",
    });
  });

  test("parseYaml：续行前有空行时也不截断", () => {
    expect(parseYaml("ka00000000001: Bitte die virtuelle Maschine\n\n  jetzt neu starten\nka00000000002: ok\n").ka00000000001).toBe(
      "Bitte die virtuelle Maschine\njetzt neu starten",
    );
  });

  test("parseYaml：内容中没有任何条目行时返回 null", () => {
    expect(parseYaml("null")).toBeNull();
    expect(parseYaml("<html>")).toBeNull();
  });

  test("复数：英文 one 写成「One core」时，de 的 one 改用英文 other 拼原文，照样翻译", async () => {
    const en = { variations: { plural: { one: unit("One core", "new"), other: unit("%lld cores", "new") } } },
      catalogs = catalogsOf({ "%lld cores": { localizations: { en } } });
    const report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport: fakeTransport({ "1 cores": "1 Kern", "2 cores": "2 Kerne" }) });
    expect(report.written).toBe(2);
    const de = catalogs.Localizable.strings["%lld cores"].localizations.de.variations.plural;
    expect([de.one.stringUnit.value, de.other.stringUnit.value]).toEqual(["%lld Kern", "%lld Kerne"]);
  });

  test("复数：修正对照英文 other，other 有 … 时 one 的 ... 也会还原", async () => {
    const en = { variations: { plural: { one: unit("%lld file", "new"), other: unit("%lld files…", "new") } } },
      catalogs = catalogsOf({ "%lld files…": { localizations: { en } } });
    const report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport: fakeTransport({ "1 file": "1 Datei...", "2 files…": "2 Dateien…" }) });
    expect(report.written).toBe(2);
    expect(catalogs.Localizable.strings["%lld files…"].localizations.de.variations.plural.one.stringUnit.value).toBe("%lld Datei…");
  });

  test("--limit 落在复数键中间时，这个键的全部类别都处理", async () => {
    const en = { variations: { plural: { one: unit("%lld Core", "new"), other: unit("%lld Cores", "new") } } },
      catalogs = catalogsOf({ "%lld Cores": { localizations: { en } }, Z: {} });
    const report = await translateLang({
      catalogs,
      lang: "ru",
      api_lang: "ru",
      transport: fakeTransport({ "21 Cores": "21 ядро", "2 Cores": "2 ядра", "5 Cores": "5 ядер" }),
      limit: 1,
    });
    expect(report.written).toBe(4);
    expect(catalogs.Localizable.strings.Z.localizations).toBeUndefined();
  });

  test("deriveLang 不因长度异常拒绝转换", () => {
    const catalogs = catalogsOf({ "Dynamic Resolution": { localizations: { "zh-Hant": unit("動態") } } });
    expect(deriveLang({ catalogs, lang: "zh-HK", derive: { from: "zh-Hant", opencc: "tw-hk" } }).written).toBe(1);
  });

  test("例外清单与 check.js 一致：命中的规则不拒绝，只放行对应的表、键和语言", async () => {
    const exceptions = () =>
      exceptionMatcherOf([
        { table: "Localizable", key: "Show all Windows", rule: "term:Windows", reason: "窗口列表" },
        { table: "Localizable", key: "Open the settings", rule: "length", lang: "de", reason: "德语习惯写法" },
      ]);
    const catalogs = catalogsOf({ "Show all Windows": {}, "Install Windows now": {}, "Open the settings": {} }),
      transport = fakeTransport({ "Show all Windows": "Alle Fenster anzeigen", "Install Windows now": "Fenster jetzt installieren", "Open the settings": "Die Einstellungen der Anwendung jetzt öffnen" }),
      report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport, exceptions: exceptions() });
    expect(catalogs.Localizable.strings["Show all Windows"].localizations.de.stringUnit.value).toBe("Alle Fenster anzeigen");
    expect(catalogs.Localizable.strings["Open the settings"].localizations.de.stringUnit.value).toBe("Die Einstellungen der Anwendung jetzt öffnen");
    expect(report.failed.map((f) => f.key)).toEqual(["Install Windows now"]);
    // 例外只放行 check.js 的长度范围，明显失控的长度照样拒绝
    const runaway = await translateLang({ catalogs: catalogsOf({ "Open the settings": {} }), lang: "de", api_lang: "de", transport: fakeTransport({ "Open the settings": "x".repeat(500) }), exceptions: exceptions() });
    expect(runaway.failed[0].reason).toContain("译文长度异常");
    // 其他语言不受 lang: "de" 的例外影响
    const ja = await translateLang({ catalogs: catalogsOf({ "Open the settings": {} }), lang: "ja", api_lang: "ja", transport: fakeTransport({ "Open the settings": "アプリケーションの設定画面を今すぐここで開いてください" }), exceptions: exceptions() });
    expect(ja.failed[0].reason).toContain("译文长度异常");
  });

  test("deriveLang 也遵守例外清单", () => {
    const catalogs = catalogsOf({ Windows: { localizations: { "zh-Hant": unit("視窗") } } }),
      derive = { from: "zh-Hant", opencc: "tw-hk" };
    expect(deriveLang({ catalogs, lang: "zh-HK", derive }).failed[0].reason).toContain("Windows");
    const exceptions = exceptionMatcherOf([{ table: "Localizable", key: "Windows", rule: "term:Windows", reason: "窗口列表" }]);
    expect(deriveLang({ catalogs, lang: "zh-HK", derive, exceptions }).written).toBe(1);
  });

  test("parseYaml：接口把弯引号换成没转义的直引号时，修复后照样取值；已转义的引号不受影响", () => {
    const [a, b, c] = ["k0123456789ab", "k0123456789ac", "k0123456789ad"],
      out = parseYaml(a + ': ""{1}"에서"\n' + b + ': "Avaa asetukset"\n' + c + ': "a \\"b\\" "{1}" c"\n');
    expect(out).toEqual({ [a]: '"{1}"에서', [b]: "Avaa asetukset", [c]: 'a "b" "{1}" c' });
    // 末尾不是引号的行无法确定边界，按缺失处理
    expect(parseYaml(a + ': "x "y" z\n' + b + ': "ok"\n')).toEqual({ [b]: "ok" });
  });

  test("polishOf：原文用弯引号、译文只有成对的直引号时还原成弯引号", () => {
    expect(polishOf("ko", "From “%@”", '"%@"에서')).toBe("“%@”에서");
    expect(polishOf("ar", "Delete “%@” and “%@”?", 'حذف "%@" و "%@"؟')).toBe("حذف “%@” و “%@”؟");
    // 译文已有本语言的引号、原文没有弯引号、直引号不成对时不改
    expect(polishOf("de", "From “%@”", "Von „%@“")).toBe("Von „%@“");
    expect(polishOf("fi", "Download '%@'?", 'Ladata "%@"?')).toBe('Ladata "%@"?');
    expect(polishOf("fr", "From “%@”", 'De "%@')).toBe('De "%@');
  });

  test("polishOf：引号换成这种语言的写法；原文同时有直引号时不改", () => {
    expect(polishOf("zh-Hant", "From “%@”", "來自“%@”")).toBe("來自「%@」");
    expect(polishOf("ja", "From “%@”", '"%@"から')).toBe("「%@」から");
    expect(polishOf("de", "From “%@”", 'Von "%@"')).toBe("Von „%@“");
    expect(polishOf("fr", "From “%@”", 'De "%@"')).toBe("De «\u00a0%@\u00a0»");
    expect(polishOf("zh-Hans", "From “%@”", "来自“%@”")).toBe("来自“%@”");
    expect(polishOf("de", 'Say "yes" to “%@”', 'Sag "ja" zu "%@"')).toBe('Sag "ja" zu "%@"');
  });

  test("引号数量和英文不同的译文不写入：解析时被吞掉 1 对引号", async () => {
    const catalogs = catalogsOf({ "“%@” and “%@”": {} }),
      transport = async (from, to, path, yaml) => yaml.replace(/"“\{1\}” and “\{2\}”"/, '"{1}" und "{2}"'),
      report = await translateLang({ catalogs, lang: "de", api_lang: "de", transport });
    expect(report.written).toBe(0);
    expect(report.failed[0].reason).toContain("引号数量和英文不同");
  });

  test("复制的复数类别命中例外时照样写入", async () => {
    const en = { variations: { plural: { one: unit("%lld Window", "new"), other: unit("%lld Windows", "new") } } },
      catalogs = catalogsOf({ "%lld Windows": { localizations: { en } } }),
      exceptions = exceptionMatcherOf([{ table: "Localizable", key: "%lld Windows", rule: "term:Windows", reason: "窗口" }]),
      transport = fakeTransport({ "1 Window": "1 okno", "21 Windows": "21 okno", "2 Windows": "2 okna", "5 Windows": "5 okien" }),
      report = await translateLang({ catalogs, lang: "pl", api_lang: "pl", transport, exceptions });
    expect(report.failed).toEqual([]);
    expect(Object.keys(catalogs.Localizable.strings["%lld Windows"].localizations.pl.variations.plural).sort()).toEqual(["few", "many", "one", "other"]);
  });

  test("接口返回没转义的引号时照样写入，并还原弯引号", async () => {
    const catalogs = catalogsOf({ "From “%@”": {} }),
      transport = async (from, to, path, yaml) => yaml.replace(/"From “\{1\}”"/, '""{1}"에서"'),
      report = await translateLang({ catalogs, lang: "ko", api_lang: "ko", transport });
    expect(report.written).toBe(1);
    expect(catalogs.Localizable.strings["From “%@”"].localizations.ko.stringUnit.value).toBe("“%@”에서");
  });
});

describe("短标签", () => {
  test("isShortLabel：最多 2 个词、不含占位符；只数字母和数字串", () => {
    for (const s of ["Killing", "Send Key", "Escape (⎋)", "Caps Lock (⇪)", "Clone…", "HiDPI (Retina)", "macOS 12+", "50%% done"]) expect(isShortLabel(s)).toBe(true);
    for (const s of ["Open the settings", "Delete %@", "%lld Cores", "Use NVMe Interface", "50%% done now"]) expect(isShortLabel(s)).toBe(false);
  });

  test("pendingOf 跳过短标签并标记 short；复数和长句照常翻译", () => {
    const skipped = [],
      { units } = pendingOf(catalogsOf({ Killing: {}, "Open the settings": {}, "%lld Cores": {} }), "de", skipped);
    expect(units.map((u) => u.key)).toEqual(["Open the settings", "%lld Cores"]);
    expect(skipped).toEqual([{ table: "Localizable", key: "Killing", short: true, reason: "短标签缺少上下文，留给 utm-i18n skill 补译" }]);
  });

  test("translateLang 不发送短标签，报告中计入 skipped", async () => {
    const log = [],
      report = await translateLang({ catalogs: catalogsOf({ Force: {}, "Open the settings": {} }), lang: "de", api_lang: "de", transport: fakeTransport({ "Open the settings": "Einstellungen öffnen" }, log) });
    expect(report.written).toBe(1);
    expect(report.skipped.map((s) => s.key)).toEqual(["Force"]);
    expect(log.join("")).not.toContain("Force");
  });
});
