// webc 翻译接口客户端；请求格式与 @1-/tran 一致：POST <api>tran，请求头 token，请求体 [from_id, to_id, path, text]
// 返回 [译文全文, src_id]。语言 id 是 @3-/lang/CODE.js 中的下标，这个顺序是与服务端的约定

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import CODE from "@3-/lang/CODE.js";

export const API_URL = (process.env.WEBC_API ?? "https://api.webc.site/") + "tran";

// token 优先取环境变量 WEBC_TOKEN，其次取 ~/.config/webc.site.yml；不要打印 token
export const tokenOf = () => {
  if (process.env.WEBC_TOKEN) return process.env.WEBC_TOKEN;
  const path = join(homedir(), ".config/webc.site.yml");
  if (!existsSync(path)) return null;
  return Bun.YAML.parse(readFileSync(path, "utf8"))?.token ?? null;
};

export const langIdOf = (code) => {
  const id = CODE.indexOf(code);
  if (id < 0) throw new Error("翻译接口不支持语言代码 " + code);
  return id;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 4xx（429 除外）与返回格式错误：重试也不会成功，调用方应中止整次运行
export class FatalError extends Error {}

// 返回发送函数 (from, to, path, text) => 译文全文；网络错误、超时、429 和 5xx 最多重试 retries 次
// 429 按 Retry-After 等待，最多 60 秒
export const transportOf = (token, { url = API_URL, retries = 3, timeout = 100_000, fetchFn = fetch } = {}) => {
  if (!token) throw new Error("没有翻译接口的 token：设置环境变量 WEBC_TOKEN，或写入 ~/.config/webc.site.yml");
  return async (from, to, path, text) => {
    const body = JSON.stringify([langIdOf(from), langIdOf(to), path, text]);
    let last,
      wait = 0;
    for (let i = 0; i <= retries; i++) {
      if (i) await sleep(Math.max(wait, 1000 * 2 ** (i - 1)));
      wait = 0;
      try {
        const res = await fetchFn(url, { method: "POST", headers: { token }, body, signal: AbortSignal.timeout(timeout) });
        if (res.status === 429) wait = Math.min(Number(res.headers.get("retry-after")) || 0, 60) * 1000;
        if (res.status >= 500 || res.status === 429) throw new Error("翻译接口返回 " + res.status);
        if (!res.ok) throw new FatalError("翻译接口返回 " + res.status + ": " + (await res.text()).slice(0, 200));
        const data = await res.json().catch(() => null);
        if (!Array.isArray(data) || typeof data[0] !== "string") {
          throw new FatalError("翻译接口返回格式不符: " + JSON.stringify(data).slice(0, 200));
        }
        return data[0];
      } catch (err) {
        if (err instanceof FatalError) throw err;
        last = err;
      }
    }
    throw last;
  };
};
