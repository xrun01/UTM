import { describe, expect, test } from "bun:test";
import { FatalError, langIdOf, transportOf } from "../lib/api.js";
import { emptyCatalog } from "../lib/catalog.js";
import { maskOf, unmaskOf } from "../lib/mask.js";
import { deriveLang, integerSampleOf, parseYaml, pendingOf, polishOf, translateLang, yamlOf } from "../lib/translate.js";

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
    const catalogs = catalogsOf({ A: {}, "%lld Cores": { localizations: { en: enPlural() } } });
    const report = await translateLang({ catalogs, lang: "ru", api_lang: "ru", transport: fakeTransport({ A: "А" }), limit: 1 });
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
    await expect(translateLang({ catalogs: catalogsOf({ A: {}, B: {} }), lang: "de", api_lang: "de", transport })).rejects.toThrow("403");
    expect(calls).toBe(1);
  });

  test("整批请求失败的条目不逐条重试，失败原因保留", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      throw new Error("网络断开");
    };
    const report = await translateLang({ catalogs: catalogsOf({ A: {}, B: {} }), lang: "de", api_lang: "de", transport });
    expect(calls).toBe(1);
    expect(report.failed.map((f) => f.reason)).toEqual(["请求失败: 网络断开", "请求失败: 网络断开"]);
  });

  test("重试换一个键，绕开服务端的按行缓存；两次都不合格时保留第 1 次的原因", async () => {
    const sent = [];
    const transport = async (...args) => {
      sent.push(args[3]);
      return fakeTransport({ "Install Linux": "تثبيت لينكس" })(...args);
    };
    const report = await translateLang({ catalogs: catalogsOf({ "Install Linux": {} }), lang: "ar", api_lang: "ar", transport });
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

  test("接口返回 200 但内容无法解析：按整批失败，不逐条重发", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      return "<html>Gateway</html>";
    };
    const report = await translateLang({ catalogs: catalogsOf({ A: {}, B: {}, C: {} }), lang: "de", api_lang: "de", transport });
    expect(calls).toBe(1);
    expect(report.failed.map((f) => f.reason)).toEqual(Array(3).fill("请求失败: 接口返回的内容无法解析为译文"));
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
    const report = await translateLang({ catalogs: catalogsOf({ Hello: {} }), lang: "de", api_lang: "de", transport: async (f, t, p, y) => y.replace(/: .*/g, ': ""') });
    expect(report.failed[0].reason).toContain("译文为空");
  });

  test("长度异常的机翻不写入", async () => {
    const report = await translateLang({ catalogs: catalogsOf({ Hello: {} }), lang: "de", api_lang: "de", transport: fakeTransport({ Hello: "x".repeat(500) }) });
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
        catalogs: catalogsOf({ "Install Linux": {} }),
        lang: "ar",
        api_lang: "ar",
        transport: async (...args) => (sent.push(args[3]), fakeTransport({ "Install Linux": "تثبيت لينكس" })(...args)),
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

