#!/usr/bin/env -S bun
// 纯 JS 权限文件合成、嵌套框架与 XPC 服务自底向上重签名及 git/dist/<mode> 产物部署

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import DIST from "./dir/DIST.js";
import UTM from "./dir/UTM.js";
import { dirWalk, WALK_NEXT, WALK_SKIP_DIR } from "./dirWalk.js";
import { run$ } from "./sh.js";

const BUNDLE_PREFIX = "com.utmapp",
  APP_GROUP = BUNDLE_PREFIX + ".UTM",
  HV_JIT_XML_TAIL =
    "\t<key>com.apple.security.hypervisor</key>\n\t<true/>\n" +
    "\t<key>com.apple.security.cs.allow-jit</key>\n\t<true/>\n</dict>",
  ENT_CFG_LI = [
    ["utm.entitlements", "Platform/macOS/macOS-unsigned.entitlements", true],
    ["launcher.entitlements", "QEMULauncher/QEMULauncher-unsigned.entitlements", false],
    ["renderer.entitlements", "QEMURenderServer/QEMURenderServer-unsigned.entitlements", false],
    ["helper.entitlements", "QEMUHelper/QEMUHelper-unsigned.entitlements", false],
    ["cli.entitlements", "utmctl/utmctl-unsigned.entitlements", false],
  ],
  // 纯 JS 规整 entitlements XML：展开 Xcode 变量并按需注入 Hypervisor 与 JIT 权限
  entitlementsXmlBuild = (rel_path, add_hv_jit = false) => {
    const base_xml = readFileSync(join(UTM, rel_path), "utf8")
      .replaceAll(
        "$(TeamIdentifierPrefix)$(PRODUCT_BUNDLE_PREFIX:default=com.utmapp).UTM",
        APP_GROUP,
      )
      .replaceAll("$(PRODUCT_BUNDLE_PREFIX:default=com.utmapp)", BUNDLE_PREFIX);
    return add_hv_jit ? base_xml.replace("</dict>", HV_JIT_XML_TAIL) : base_xml;
  },
  // 批量生成签名所需的临时 entitlements 文件并返回路径列表
  entitlementsFileLiWrite = (tmp_dir) =>
    ENT_CFG_LI.map(([file_name, rel_src, add_hv]) => {
      const out_path = join(tmp_dir, file_name);
      writeFileSync(out_path, entitlementsXmlBuild(rel_src, add_hv));
      return out_path;
    }),
  // 纯 JS 递归收集 .app 包内所有 Frameworks/*.framework 目录与 Frameworks/*.dylib 文件
  fwAndDylibLiCollect = (app_dir) => {
    const fw_li = [],
      dylib_li = [];
    dirWalk(app_dir, (full_path, entry, cur_dir) => {
      if (!cur_dir.endsWith("/Frameworks")) return WALK_NEXT;
      if (entry.isDirectory() && entry.name.endsWith(".framework")) {
        fw_li.push(full_path);
        return WALK_SKIP_DIR;
      }
      if (entry.isFile() && entry.name.endsWith(".dylib")) dylib_li.push(full_path);
      return WALK_NEXT;
    });
    return [fw_li, dylib_li];
  },
  // 对单个二进制或 Bundle 执行本地 ad-hoc 签名
  targetSign = async (target_path, ent_path = "") => {
    const arg_li = [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      ...(ent_path ? ["--options", "runtime", "--entitlements", ent_path] : []),
      target_path,
    ];
    await run$`codesign ${arg_li}`;
  };

export const // 对指定 .app 包执行自底向上本地重签名（供 PGO 采样与最终发布共用）
  appBundleSign = async (built_app_dir, tmp_dir) => {
    const [utm_ent, launcher_ent, renderer_ent, helper_ent, cli_ent] =
        entitlementsFileLiWrite(tmp_dir),
      [fw_li, dylib_li] = fwAndDylibLiCollect(built_app_dir),
      xpc_macos_dir = join(built_app_dir, "Contents/XPCServices/QEMUHelper.xpc/Contents/MacOS"),
      nested_target_li = [
        [join(xpc_macos_dir, "QEMULauncher.app/Contents/MacOS/QEMULauncher"), launcher_ent],
        [join(xpc_macos_dir, "QEMURenderServer.app/Contents/MacOS/QEMURenderServer"), renderer_ent],
        [join(xpc_macos_dir, "QEMUHelper"), helper_ent],
        [join(built_app_dir, "Contents/MacOS/utmctl"), cli_ent],
      ];

    for (let i = 0; i < dylib_li.length; ++i) await targetSign(dylib_li[i]);
    for (let i = 0; i < fw_li.length; ++i) await targetSign(fw_li[i]);
    for (let i = 0; i < nested_target_li.length; ++i) {
      const [bin_path, ent_path] = nested_target_li[i];
      if (existsSync(bin_path)) await targetSign(bin_path, ent_path);
    }
    await targetSign(built_app_dir, utm_ent);
  },
  // 自底向上重签名并将产物部署至 git/dist/<mode_sub>
  distAppStage = async (built_app_dir, tmp_dir, mode_sub) => {
    console.log("正在生成虚拟化与 Hypervisor 权限清单并执行自底向上重签名...");
    await appBundleSign(built_app_dir, tmp_dir);

    const out_dir = join(DIST, mode_sub),
      dist_app = join(out_dir, "UTM.app"),
      dist_cli = join(out_dir, "utmctl");
    mkdirSync(out_dir, { recursive: true });
    rmSync(dist_app, { recursive: true, force: true });
    rmSync(dist_cli, { force: true });
    cpSync(built_app_dir, dist_app, { recursive: true, verbatimSymlinks: true });
    symlinkSync("UTM.app/Contents/MacOS/utmctl", dist_cli);

    await run$`codesign -vvv ${dist_app}`;
    return [dist_app, dist_cli];
  };
