// 扫描 Swift / ObjC 源码中的字符串字面量，跳过注释
// 支持 Swift 的多行字符串 """、原始字符串 #"..."#、插值 \(...)（可嵌套字符串）与可嵌套块注释

// 返回 [{ line, text }]，每个字符串字面量一项；text 是字面量的原始内容（不含引号，插值部分不计入）
export const stringLiteralsOf = (src, { swift = true } = {}) => {
  const out = [];
  let i = 0,
    line = 1;
  const n = src.length,
    peek = (s) => src.startsWith(s, i),
    advance = (k = 1) => {
      for (let j = 0; j < k && i < n; j++, i++) if (src[i] === "\n") line++;
    };

  // 扫描代码，直到遇到 stop（插值的右括号）或文件结束
  const scanCode = (in_interp) => {
    let depth = 0;
    while (i < n) {
      if (peek("//")) {
        while (i < n && src[i] !== "\n") advance();
      } else if (peek("/*")) {
        // Swift 的块注释可以嵌套；C 的块注释遇到第一个 */ 就结束
        advance(2);
        let nest = 1;
        while (i < n && nest > 0) {
          if (swift && peek("/*")) {
            nest++;
            advance(2);
          } else if (peek("*/")) {
            nest--;
            advance(2);
          } else advance();
        }
      } else if (swift && src[i] === "#" && /^#+"/.test(src.slice(i, i + 16))) {
        const hashes = src.slice(i).match(/^#+/)[0];
        advance(hashes.length);
        scanString(hashes);
      } else if (src[i] === '"') {
        scanString("");
      } else if (src[i] === "'" && !swift) {
        // C 字符字面量
        advance();
        while (i < n && src[i] !== "'") advance(src[i] === "\\" ? 2 : 1);
        advance();
      } else if (in_interp && src[i] === "(") {
        depth++;
        advance();
      } else if (in_interp && src[i] === ")") {
        if (depth === 0) {
          advance();
          return;
        }
        depth--;
        advance();
      } else advance();
    }
  };

  // i 指向开头的引号；hashes 是原始字符串的 # 前缀
  const scanString = (hashes) => {
    const multi = swift && peek('"""'),
      quote = multi ? '"""' : '"',
      close = quote + hashes,
      interp = "\\" + hashes + "(",
      start_line = line;
    advance(quote.length);
    let text = "";
    while (i < n) {
      if (peek(close)) {
        advance(close.length);
        break;
      }
      if (!multi && src[i] === "\n") break;
      if (swift && peek(interp)) {
        advance(interp.length);
        scanCode(true);
        continue;
      }
      if (src[i] === "\\" && hashes === "") {
        text += src.slice(i, i + 2);
        advance(2);
        continue;
      }
      text += src[i];
      advance();
    }
    out.push({ line: start_line, text });
  };

  scanCode(false);
  return out;
};

export const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
