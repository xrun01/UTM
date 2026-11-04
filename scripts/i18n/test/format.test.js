import { describe, expect, test } from "bun:test";
import { signatureOf, specMismatchOf, specsOf } from "../lib/format.js";

describe("specsOf", () => {
  test("识别常见占位符，不把 %% 当成占位符", () => {
    expect(specsOf("%@ %lld %.1f %d%% %#@n@").map((s) => s.type)).toEqual(["@", "lld", "f", "d", "var:n"]);
  });

  test("不带序号的占位符按出现顺序编号，带序号的用自己的序号", () => {
    expect(specsOf("%@ %@").map((s) => s.pos)).toEqual([1, 2]);
    expect(specsOf("%2$@ %1$lld").map((s) => [s.pos, s.type])).toEqual([
      [2, "@"],
      [1, "lld"],
    ]);
  });

  test("等价写法归为同一类型：%ld 与 %lld、%i 与 %d", () => {
    expect(signatureOf("%ld %i")).toBe(signatureOf("%lld %d"));
  });
});

describe("specMismatchOf", () => {
  test("调换顺序但用了带序号的写法：一致", () => {
    expect(specMismatchOf("Failed to open %@ because %@.", "由于 %2$@，无法打开 %1$@。")).toBeNull();
  });

  test("英文用带序号的写法、译文按顺序写：一致", () => {
    expect(specMismatchOf("%1$@ (%2$@)", "%@（%@）")).toBeNull();
  });

  test("缺少占位符", () => {
    expect(specMismatchOf("Copy %@ to %@?", "复制到 %@？")).toContain("占位符不一致");
  });

  test("类型不同", () => {
    expect(specMismatchOf("%lld Cores", "%@ 核")).toContain("占位符不一致");
  });

  test("混用带序号和不带序号的占位符", () => {
    expect(specMismatchOf("%@ %@", "%2$@ %@")).toBe("译文混用了带序号和不带序号的占位符");
  });

  test("同一个参数在译文中出现 2 次：一致", () => {
    expect(specMismatchOf("%@", "%1$@ (%1$@)")).toBeNull();
  });
});

describe("边界写法", () => {
  test("空格不是标志：「50% done」「100% CPU」里没有占位符", () => {
    expect(specsOf("50% done")).toEqual([]);
    expect(specsOf("100% CPU")).toEqual([]);
  });

  test("宽度或精度写成 * 时也占 1 个参数", () => {
    expect(signatureOf("%*d")).toBe("1:d,2:d");
    expect(signatureOf("%.*f")).toBe("1:d,2:f");
    expect(signatureOf("%2$*1$d")).toBe("1:d,2:d");
    expect(specMismatchOf("%d", "%*d")).toContain("占位符不一致");
  });

  test("%lf 与 %f 是同一类型", () => expect(specMismatchOf("%f", "%lf")).toBeNull());

  test("带位置的 stringsdict 变量", () => expect(signatureOf("%1$#@n@")).toBe("1:var:n"));

  test("格式文案中的字面量百分号必须写成 %%", () => {
    expect(specMismatchOf("%lld%%", "%lld %")).toBe("格式文案中的百分号必须写成 %%");
    expect(specMismatchOf("%lld%%", "%lld %%")).toBeNull();
    expect(specMismatchOf("50% done", "50 % terminé")).toBeNull();
  });
});

