import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyCatalog, readCatalog, serializeCatalog, sourceLocOf, unitAt, unitsOf, writeCatalog } from "../lib/catalog.js";

const fixture = (name) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("serializeCatalog 与 xcstringstool 逐字节一致", () => {
  // fixture 由 xcstringstool sync 生成：含转义、斜杠、emoji、复数、stale、needs_review
  for (const name of ["escapes.xcstrings", "plural-stale.xcstrings"]) {
    test(name + " 往返后不变", () => {
      const text = fixture(name);
      expect(serializeCatalog(JSON.parse(text))).toBe(text);
    });
  }

  test("键按码点排序：emoji 排在全角字符之后（UTF-16 码元比较会排在前面）", () => {
    expect(Object.keys(JSON.parse(serializeCatalog({ "😀": 1, "！": 2, "\ue000": 3 })))).toEqual(["\ue000", "！", "😀"]);
  });

  test("空对象中间有空行，文件末尾没有换行", () => {
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


  test("sourceLocOf：有 en 值时用 en 值，否则用键", () => {
    expect(sourceLocOf("%@ (%@)", { localizations: { en: { stringUnit: { value: "%1$@ (%2$@)" } } } }).stringUnit.value).toBe(
      "%1$@ (%2$@)",
    );
    expect(sourceLocOf("Hello", {}).stringUnit.value).toBe("Hello");
  });
});

describe("读写文件", () => {
  test("readCatalog：有合并冲突标记时报出文件路径和原因", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-cat-")),
      path = join(dir, "Localizable.xcstrings");
    writeFileSync(path, '{\n<<<<<<< HEAD\n  "a" : 1\n=======\n  "a" : 2\n>>>>>>> x\n}');
    expect(() => readCatalog(path)).toThrow(path + " 无法解析：文件中有合并冲突标记，先解决冲突");
    writeFileSync(path, "{ bad");
    expect(() => readCatalog(path)).toThrow("文件不是合法的 JSON");
    rmSync(dir, { recursive: true, force: true });
  });

  test("writeCatalog：写完后目录中没有残留的临时文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-cat-")),
      path = join(dir, "Localizable.xcstrings");
    writeCatalog(path, emptyCatalog());
    expect(readdirSync(dir)).toEqual(["Localizable.xcstrings"]);
    expect(readCatalog(path)).toEqual(emptyCatalog());
    rmSync(dir, { recursive: true, force: true });
  });
});

