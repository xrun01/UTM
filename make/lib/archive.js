#!/usr/bin/env -S bun
// Xcode 归档编译驱动与 .app 产物纯 JS 递归定位

import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirWalk, WALK_NEXT, WALK_STOP } from "./dirWalk.js";
import xcodeArgLiBuild from "./flag.js";
import { MODE_DEBUG, MODE_TO_LABEL } from "./mode.js";
import { run$ } from "./sh.js";
import ARCH from "./sys/ARCH.js";
import CPU_N from "./sys/CPU_N.js";

const // 在归档目录中纯 JS 递归定位首个 .app 包路径
  appBundleFind = (root_dir) => {
    const std_app = join(root_dir, "Products/Applications/UTM.app");
    return existsSync(std_app)
      ? std_app
      : dirWalk(root_dir, (_full_path, entry) =>
          entry.isDirectory() && entry.name.endsWith(".app") ? WALK_STOP : WALK_NEXT,
        );
  };

export default async (
  mode,
  archive_path,
  pgo_raw_dir = "",
  profdata_path = "",
  order_path = "",
) => {
  const arg_li = xcodeArgLiBuild(mode, archive_path, pgo_raw_dir, profdata_path, order_path),
    lto_note = mode === MODE_DEBUG ? "" : ", Swift 全模块单线程 + LTO";

  console.log(
    "正在以 " +
      MODE_TO_LABEL[mode] +
      " 模式编译 git/UTM (架构: " +
      ARCH +
      ", 调度并发: " +
      CPU_N +
      lto_note +
      ")...",
  );
  await run$`xcodebuild ${arg_li}`;

  const built_app = appBundleFind(archive_path);
  if (!built_app) throw new Error("未在归档目录中找到构建产物 UTM.app: " + archive_path);
  return built_app;
};
