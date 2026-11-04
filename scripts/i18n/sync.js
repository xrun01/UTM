#!/usr/bin/env bun
// 把源码中的文案同步进 3 个 String Catalog，删除源码已不用的键
// 用法：先运行 bun vm/script/buildApp.js，再运行 bun scripts/i18n/sync.js

import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { syncAll } from "./lib/sync.js";

const { values: opt } = parseArgs({
  options: {
    root: { type: "string", default: resolve(import.meta.dirname, "../..") },
    "build-dir": { type: "string" },
  },
});

try {
  const root = resolve(opt.root),
    { tables, removed_written } = syncAll({ root, build_dir: opt["build-dir"] ?? join(root, "build/i18n"), write: true });
  for (const { path, before, after, stats } of Object.values(tables)) {
    console.log(
      relative(root, path) +
        (before === after ? "：没有变化" : "：新增 " + stats.added + "，删除 " + stats.removed + "，改为 needs_review " + stats.changed),
    );
  }
  if (removed_written) console.log("i18n/removed.json：记录了被删除键的译文，和 catalog 一起提交");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
