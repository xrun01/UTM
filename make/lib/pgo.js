#!/usr/bin/env -S bun
// 两阶段 IR-PGO + Temporal Profiling 函数重排(Order File)自动化采样与合并

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import archiveBuild from "./archive.js";
import { PGO_DIR } from "./dir/BUILD.js";
import UTM from "./dir/UTM.js";
import { MODE_PGO_GEN } from "./mode.js";
import { BUILD_ENV, env$, run$ } from "./sh.js";
import { appBundleSign } from "./sign.js";

const PROFDATA_PATH = join(PGO_DIR, "utm.profdata"),
  ORDER_PATH = join(PGO_DIR, "utm.order"),
  QUIT_APPLESCRIPT = 'tell application id "com.utmapp.UTM" to quit',
  // 将 llvm-profdata order 输出规整为 Mach-O 链接器(-order_file)符号序列
  machoOrderTextNorm = (raw_text) => {
    const line_li = raw_text.split("\n"),
      sym_set = new Set(),
      out_li = [];
    for (let i = 0; i < line_li.length; ++i) {
      const sym = line_li[i].trim();
      if (!sym || sym.startsWith("#")) continue;
      const cand_li = sym.startsWith("_") ? [sym] : ["_" + sym, sym];
      for (let j = 0; j < cand_li.length; ++j) {
        const cand = cand_li[j];
        if (!sym_set.has(cand)) {
          sym_set.add(cand);
          out_li.push(cand);
        }
      }
    }
    return out_li.join("\n") + "\n";
  },
  // 运行插桩版命令行与主程序采集运行时 PGO 与 Temporal 轨迹文件列表
  pgoTraceCollect = async (pgo_app, pgo_raw_dir) => {
    console.log("正在运行插桩版 UTM 与 utmctl 采集运行时 PGO 与 Temporal 调用轨迹...");
    const utm_bin = join(pgo_app, "Contents/MacOS/UTM"),
      cli_bin = join(pgo_app, "Contents/MacOS/utmctl"),
      trace$ = env$({ LLVM_PROFILE_FILE: join(pgo_raw_dir, "%p_%m.profraw") }, UTM, true);

    await trace$`${cli_bin} --help`.nothrow();
    await trace$`${cli_bin} version`.nothrow();
    await trace$`${cli_bin} list`.nothrow();

    const gui_proc = Bun.spawn([utm_bin], {
      cwd: UTM,
      env: { ...BUILD_ENV, LLVM_PROFILE_FILE: join(pgo_raw_dir, "%p_%m%c.profraw") },
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(2500);
    await trace$`osascript -e ${QUIT_APPLESCRIPT}`.nothrow();
    await Bun.sleep(500);
    gui_proc.kill();

    return readdirSync(pgo_raw_dir)
      .filter((name) => name.endsWith(".profraw"))
      .map((name) => join(pgo_raw_dir, name));
  },
  // 合并采样数据并生成 Mach-O 函数重排布局文件
  pgoProfileMerge = async (profraw_li, tmp_dir) => {
    console.log("正在合并 " + profraw_li.length + " 份采样文件并计算最优指令缓存函数布局序...");
    await run$`xcrun llvm-profdata merge -output=${PROFDATA_PATH} ${profraw_li}`;
    const raw_order_path = join(tmp_dir, "raw.order");
    await run$`xcrun llvm-profdata order --output=${raw_order_path} ${PROFDATA_PATH}`;
    writeFileSync(ORDER_PATH, machoOrderTextNorm(readFileSync(raw_order_path, "utf8")));
    return [PROFDATA_PATH, ORDER_PATH];
  };

export default async (tmp_dir) => {
  if (existsSync(PROFDATA_PATH) && existsSync(ORDER_PATH)) {
    console.log("复用已缓存的 PGO 与 Temporal 布局剖析数据: " + PGO_DIR);
    return [PROFDATA_PATH, ORDER_PATH];
  }

  const pgo_raw_dir = join(tmp_dir, "pgo_raw"),
    pgo_archive = join(tmp_dir, "UTM-PGO.xcarchive");
  mkdirSync(PGO_DIR, { recursive: true });
  mkdirSync(pgo_raw_dir, { recursive: true });

  const pgo_app = await archiveBuild(MODE_PGO_GEN, pgo_archive, pgo_raw_dir);
  await appBundleSign(pgo_app, tmp_dir);

  const profraw_li = await pgoTraceCollect(pgo_app, pgo_raw_dir);
  return profraw_li.length > 0 ? pgoProfileMerge(profraw_li, tmp_dir) : ["", ""];
};
