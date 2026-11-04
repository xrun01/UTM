// 格式占位符解析：%@、%lld、%1$@、%.1f、%#@var@ 与字面量 %%

// 依次匹配：%%、stringsdict 变量 %#@name@、printf 格式（可带位置 n$、标志、宽度、精度、长度修饰）
const SPEC_RE = /%%|%#@([A-Za-z_][A-Za-z0-9_]*)@|%(?:(\d+)\$)?[-+ #0']*(?:\d+|\*)?(?:\.(?:\d+|\*))?(hh|h|ll|l|q|L|z|t|j)?([@dDiuUxXoOfFeEgGaAcCsSp])/g;

// 同一个参数的不同写法视为同一类型：%d 与 %i、%ld 与 %lld 在 64 位平台上等价
const TYPE_ALIAS = { i: "d", D: "d", U: "u", O: "o", F: "f" },
  LEN_ALIAS = { l: "ll", q: "ll" };

const typeOf = (len, conv) => (LEN_ALIAS[len] ?? len ?? "") + (TYPE_ALIAS[conv] ?? conv);

// 返回占位符列表：{ raw, index, start, end, pos, type, var }；%% 不计入
export const specsOf = (text) => {
  const out = [];
  let seq = 0;
  for (const m of text.matchAll(SPEC_RE)) {
    if (m[0] === "%%") continue;
    const base = { raw: m[0], start: m.index, end: m.index + m[0].length };
    if (m[1] !== undefined) out.push({ ...base, var: m[1], type: "var:" + m[1] });
    else out.push({ ...base, pos: m[2] ? Number(m[2]) : ++seq, explicit: !!m[2], type: typeOf(m[3], m[4]) });
  }
  return out;
};

// 占位符签名：位置参数按位置排序成 "1:@,2:lld"；stringsdict 变量按名字排序
export const signatureOf = (text) => {
  const specs = specsOf(text),
    pos = specs.filter((s) => s.pos !== undefined).map((s) => s.pos + ":" + s.type),
    vars = specs.filter((s) => s.var !== undefined).map((s) => s.type);
  return [...new Set(pos)].sort().concat([...new Set(vars)].sort()).join(",");
};

// 比较原文与译文的占位符：返回问题描述，没有问题时返回 null
export const specMismatchOf = (source, translation) => {
  const pos_li = specsOf(translation).filter((s) => s.pos !== undefined);
  if (pos_li.some((s) => s.explicit) && pos_li.some((s) => !s.explicit)) {
    return "译文混用了带序号和不带序号的占位符";
  }
  const a = signatureOf(source),
    b = signatureOf(translation);
  return a === b ? null : "占位符不一致：原文 [" + a + "]，译文 [" + b + "]";
};
