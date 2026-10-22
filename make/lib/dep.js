#!/usr/bin/env -S bun
// 构建依赖自检与自动安装：Homebrew 基础包、Xcode Metal 工具链、mise 激活与 uv 依赖升级同步

import { existsSync } from "node:fs";
import { join } from "node:path";
import UTM from "./dir/UTM.js";
import { BREW_PREFIX, BUILD_ENV, quiet$, run$ } from "./sh.js";

const // 必需的 Homebrew 包与对应可执行文件列表: [包名, 命令名]
  BREW_PKG_LI = [
    ["gh", "gh"],
    ["jq", "jq"],
    ["bison", "bison"],
    ["pkg-config", "pkg-config"],
    ["gettext", "msgfmt"],
    ["glib", "glib-compile-schemas"],
    ["glib-utils", "glib-mkenums"],
    ["libgpg-error", "gpgrt-config"],
    ["nasm", "nasm"],
    ["meson", "meson"],
    ["ninja", "ninja"],
    ["cmake", "cmake"],
    ["llvm", "llvm-objdump"],
    ["spirv-llvm-translator", "llvm-spirv"],
    ["libxcb", ""],
    ["libxrandr", ""],
    ["mise", "mise"],
    ["uv", "uv"],
  ],
  brewPkgHas = (pkg, cmd) =>
    existsSync(join(BREW_PREFIX, "opt", pkg)) ||
    existsSync(join(BREW_PREFIX, "Cellar", pkg)) ||
    Boolean(cmd && Bun.which(cmd, { PATH: BUILD_ENV.PATH })),
  brewPkgEnsure = async () => {
    const missing_pkg_li = BREW_PKG_LI.filter(([pkg, cmd]) => !brewPkgHas(pkg, cmd)).map(
      ([pkg]) => pkg,
    );
    if (missing_pkg_li.length === 0) return;
    console.log("正在通过 Homebrew 安装缺失依赖: " + missing_pkg_li.join(", "));
    await run$`brew install ${missing_pkg_li}`;
  },
  metalToolchainEnsure = async () => {
    const { exitCode: metal_ok } = await quiet$`xcrun metal -v`.nothrow();
    if (metal_ok === 0) return;
    console.log("检测到缺失 Xcode MetalToolchain 组件，正在自动下载安装...");
    await run$`xcodebuild -downloadComponent MetalToolchain`;
  },
  pyVenvSync = async () => {
    const mise_toml = join(UTM, "mise.toml");
    if (existsSync(mise_toml) && Bun.which("mise", { PATH: BUILD_ENV.PATH }))
      await run$`mise trust ${mise_toml}`.nothrow();
    console.log("正在通过 uv 升级并同步 Python 虚拟环境依赖...");
    await run$`uv sync --upgrade`;
  };

export default async () => {
  await brewPkgEnsure();
  await metalToolchainEnsure();
  await pyVenvSync();
};
