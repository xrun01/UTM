#!/usr/bin/env -S bun
// 统一构建环境变量组装与 zx 命令执行器封装

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "zx";
import UTM from "./dir/UTM.js";

const SYS_XCODE_DEV = "/Applications/Xcode.app/Contents/Developer";

export const BREW_PREFIX = existsSync("/opt/homebrew") ? "/opt/homebrew" : "/usr/local",
  XCODE_DEV_DIR = existsSync(SYS_XCODE_DEV)
    ? SYS_XCODE_DEV
    : process.env.DEVELOPER_DIR || SYS_XCODE_DEV,
  BUILD_ENV = {
    ...process.env,
    ...(existsSync(SYS_XCODE_DEV) ? { DEVELOPER_DIR: SYS_XCODE_DEV } : {}),
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_UPGRADE: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
    UV_LINK_MODE: "copy",
    PATH: [
      join(UTM, ".venv/bin"),
      join(BREW_PREFIX, "opt/bison/bin"),
      join(BREW_PREFIX, "bin"),
      join(process.env.HOME || "", ".local/bin"),
      process.env.PATH || "",
    ].join(":"),
  },
  env$ = (extra_env = {}, cwd = UTM, quiet = false) =>
    $({ env: { ...BUILD_ENV, ...extra_env }, cwd, quiet }),
  run$ = env$(),
  quiet$ = env$({}, UTM, true);

Object.assign(process.env, BUILD_ENV);
