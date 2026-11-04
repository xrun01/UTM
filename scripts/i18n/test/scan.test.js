import { describe, expect, test } from "bun:test";
import { CJK_RE, stringLiteralsOf } from "../lib/scan.js";

const texts = (src, opt) => stringLiteralsOf(src, opt).map((l) => l.text);

describe("Swift", () => {
  test("跳过行注释和可嵌套的块注释", () => {
    const src = ['// 注释 "不是字符串"', '/* 外 /* 内 "x" */ 仍是注释 "y" */', 'let a = "ok"'].join("\n");
    expect(texts(src)).toEqual(["ok"]);
  });

  test("转义的引号不会结束字符串", () => {
    expect(texts('let a = "say \\"hi\\" 中文"')).toEqual(['say \\"hi\\" 中文']);
  });

  test("插值中的字符串单独计入，插值外的文字不丢失", () => {
    expect(texts('let b = "\\(x ? "内层" : "y") 外层"')).toEqual(["内层", "y", " 外层"]);
  });

  test("插值中的括号不会提前结束插值", () => {
    expect(texts('let c = "\\(f(g(1), "a")) tail"')).toEqual(["a", " tail"]);
  });

  test("原始字符串：引号和反斜杠是字面量", () => {
    expect(texts('let d = #"raw "中" \\(no)"#')).toEqual(['raw "中" \\(no)']);
  });

  test("原始字符串的插值写成 \\#(...)，插值外的文字合并为 1 项", () => {
    expect(texts('let d = #"a \\#(x) b"#')).toEqual(["a  b"]);
  });

  test("多行字符串", () => {
    const src = ['let m = """', '  多行 "引号"', "  第二行", '  """', 'let n = "x"'].join("\n");
    expect(texts(src)).toEqual(['\n  多行 "引号"\n  第二行\n  ', "x"]);
  });

  test("记录字符串开始的行号", () => {
    const lits = stringLiteralsOf(['let a = 1', '/* x', 'y */', 'let b = "z"'].join("\n"));
    expect(lits).toEqual([{ line: 4, text: "z" }]);
  });
});

describe("ObjC", () => {
  test("块注释不嵌套，遇到第一个 */ 就结束", () => {
    expect(texts('/* a /* b */ NSString *s = @"字"; // "注"', { swift: false })).toEqual(["字"]);
  });

  test("不闭合的字符字面量在行尾停止，不吞掉后面的代码", () => {
    expect(texts("char c = 'x;\nNSString *s = @\"中\";", { swift: false })).toEqual(["中"]);
  });

  test("字符字面量中的引号不会开始字符串", () => {
    expect(texts("char c = '\"'; NSString *t = @\"ok\";", { swift: false })).toEqual(["ok"]);
  });
});

test("CJK_RE 覆盖中日韩文字，不匹配拉丁字母和全角标点", () => {
  for (const s of ["中", "日本語", "カタカナ", "ひらがな", "한국어", "々", "ｱ", "ㄱ", "ᄀ", "𠀋"]) expect(CJK_RE.test(s)).toBe(true);
  for (const s of ["abc", "Ünïcödé", "，。"]) expect(CJK_RE.test(s)).toBe(false);
});
