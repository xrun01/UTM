import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasTranslation, serializeCatalog, sourceLocOf, unitAt, unitsOf } from "../lib/catalog.js";

const fixture = (name) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("serializeCatalog 与 xcstringstool 逐字节一致", () => {
  // fixture 由 xcstringstool sync 生成：含转义、斜杠、emoji、复数、stale、needs_review
  for (const name of ["escapes.xcstrings", "plural-stale.xcstrings"]) {
    test(name + " 往返后不变", () => {
      const text = fixture(name);
      expect(serializeCatalog(JSON.parse(text))).toBe(text);
    });
  }

  test("键按 UTF-16 码元排序，空对象中间有空行，文件末尾没有换行", () => {
    const out = serializeCatalog({ b: {}, B: 1, a: { z: "x", "/": "a/b" } });
    expect(out).toBe(
      ['{', '  "B" : 1,', '  "a" : {', '    "/" : "a/b",', '    "z" : "x"', "  },", '  "b" : {', "", "  }", "}"].join("\n"),
    );
  });

  test("空数组与 xcstringstool 的写法一致", () => {
    expect(serializeCatalog({ a: [] })).toBe('{\n  "a" : [\n\n  ]\n}');
  });
});

describe("遍历 stringUnit", () => {
  const loc = {
    variations: {
      plural: {
        one: { stringUnit: { state: "translated", value: "%lld Core" } },
        other: { stringUnit: { state: "translated", value: "%lld Cores" } },
      },
    },
  };

  test("unitsOf 返回全部复数变体及其路径", () => {
    expect(unitsOf(loc).map(([u, p]) => [u.value, p])).toEqual([
      ["%lld Core", ["plural", "one"]],
      ["%lld Cores", ["plural", "other"]],
    ]);
  });

  test("unitAt 按路径取变体，路径为空时取顶层", () => {
    expect(unitAt(loc, ["plural", "other"]).value).toBe("%lld Cores");
    expect(unitAt(loc, ["plural", "few"])).toBeUndefined();
    expect(unitAt({ stringUnit: { value: "x" } }, []).value).toBe("x");
  });

  test("hasTranslation 忽略空值", () => {
    expect(hasTranslation({ localizations: { ja: { stringUnit: { value: "" } } } }, "ja")).toBe(false);
    expect(hasTranslation({ localizations: { ja: loc } }, "ja")).toBe(true);
    expect(hasTranslation({}, "ja")).toBe(false);
  });

  test("sourceLocOf：有 en 值时用 en 值，否则用键", () => {
    expect(sourceLocOf("%@ (%@)", { localizations: { en: { stringUnit: { value: "%1$@ (%2$@)" } } } }).stringUnit.value).toBe(
      "%1$@ (%2$@)",
    );
    expect(sourceLocOf("Hello", {}).stringUnit.value).toBe("Hello");
  });
});
