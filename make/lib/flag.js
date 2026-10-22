#!/usr/bin/env -S bun
// Debug 极速编译、PGO 采样插桩与 Release 极限性能优化(融合 Thorium 编译优化策略)参数组装

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILD_DIR, SYSROOT_NAME } from "./dir/BUILD.js";
import UTM from "./dir/UTM.js";
import { MODE_DEBUG, MODE_PGO_GEN, MODE_TO_DERIVED } from "./mode.js";
import { XCODE_DEV_DIR } from "./sh.js";
import ARCH from "./sys/ARCH.js";
import CPU_N from "./sys/CPU_N.js";

const // 纯 JS 解析 Xcode 工具链内联的 LLVM Profile Runtime 静态库路径
  CLANG_LIB_ROOT = join(XCODE_DEV_DIR, "Toolchains/XcodeDefault.xctoolchain/usr/lib/clang"),
  CLANG_VER_NAME = existsSync(CLANG_LIB_ROOT) ? readdirSync(CLANG_LIB_ROOT)[0] || "21" : "21",
  PROFILE_RT_PATH = join(CLANG_LIB_ROOT, CLANG_VER_NAME, "lib/darwin/libclang_rt.profile_osx.a"),
  // 通用 Apple Silicon 微架构基线（兼容 M1..M5 全系 ARM64 Mac，启用 LSE 原子指令、FP16、DotProd、RCPC 与流水线调度调优）
  CPU_TARGET_FLAG_LI =
    ARCH === "arm64" ? ["-mcpu=apple-m1", "-mtune=apple-m1"] : ["-march=x86-64-v3"],
  SWIFT_CPU_FLAG_LI = CPU_TARGET_FLAG_LI.flatMap((flag) => ["-Xcc", flag]),
  // 融合 Thorium 的 LLVM 后端优化 Pass：激进位宽扩展消除(-aggressive-ext-opt)、DFA 跳转线程化、GVN 提升/下沉、内联与跨模块导入阈值强化、禁用机器指令外提与调试元数据自动升级检查
  LLVM_OPT_PASS_LI = [
    "-aggressive-ext-opt",
    "-enable-dfa-jump-thread",
    "-enable-gvn-hoist",
    "-enable-gvn-sink",
    "-inline-threshold=500",
    "-inlinehint-threshold=360",
    "-import-instr-limit=100",
    "-unroll-threshold=300",
    "-enable-machine-outliner=never",
    "-disable-auto-upgrade-debug-info",
  ],
  CLANG_MLLVM_FLAG_LI = LLVM_OPT_PASS_LI.flatMap((pass) => ["-mllvm", pass]),
  SWIFT_XLLVM_FLAG_LI = LLVM_OPT_PASS_LI.flatMap((pass) => ["-Xllvm", pass]),
  LD_MLLVM_FLAG_LI = LLVM_OPT_PASS_LI.flatMap((pass) => ["-Xlinker", "-mllvm", "-Xlinker", pass]),
  // Release 核心 C/ObjC 优化标志：O3、FMA 融合乘加收缩(-ffp-contract=fast)、SLP/循环矢量化、常量池合并、IEEE 安全快速浮点
  RELEASE_C_BASE_LI = [
    "$(inherited)",
    "-O3",
    ...CPU_TARGET_FLAG_LI,
    "-ffp-contract=fast",
    "-fstrict-aliasing",
    "-funroll-loops",
    "-fvectorize",
    "-fslp-vectorize",
    "-fmerge-all-constants",
    "-fvisibility-inlines-hidden",
    "-fno-math-errno",
    "-fno-trapping-math",
    ...CLANG_MLLVM_FLAG_LI,
  ],
  // Release 核心 Swift 优化标志：单线程全模块优化(-num-threads 1)、跨模块优化(CMO)、编译期独占检查与底层 LLVM Pass 强化
  RELEASE_SWIFT_BASE_LI = [
    "$(inherited)",
    "-O",
    "-whole-module-optimization",
    "-num-threads",
    "1",
    "-enable-default-cmo",
    "-enforce-exclusivity=unchecked",
    ...SWIFT_CPU_FLAG_LI,
    "-Xcc",
    "-O3",
    "-Xcc",
    "-ffp-contract=fast",
    "-Xcc",
    "-fstrict-aliasing",
    ...SWIFT_XLLVM_FLAG_LI,
  ],
  // Release 链接器优化标志(兼容 clang 与 swiftc 双驱动的 -Xlinker 语法)：ICF 重复代码折叠、剥离冗余段、单线程全局 LTO 后端
  RELEASE_LD_BASE_LI = [
    "-Xlinker",
    "-deduplicate",
    "-Xlinker",
    "-no_data_in_code_info",
    "-Xlinker",
    "-no_function_starts",
    "-Xlinker",
    "-mllvm",
    "-Xlinker",
    "-threads=1",
    ...LD_MLLVM_FLAG_LI,
  ],
  // PGO 采样阶段链接器标志(同时兼容 clang 与 swiftc 链接驱动)
  PGO_GEN_LD_LI = [
    "-Xlinker",
    PROFILE_RT_PATH,
    "-Xlinker",
    "-u",
    "-Xlinker",
    "___llvm_profile_runtime",
    "-Xlinker",
    "-deduplicate",
  ],
  // Thorium 风格 Release 预处理宏：禁用断言、开启 NEON 宏、关闭 libc++ 运行时边界硬化检查开销
  RELEASE_PREPROC_LI = [
    "$(inherited)",
    "NDEBUG=1",
    "NS_BLOCK_ASSERTIONS=1",
    "__ARM_NEON__=1",
    "_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_NONE",
  ],
  // Debug 极速编译专有覆盖项
  DEBUG_SETTING_LI = [
    "SWIFT_OPTIMIZATION_LEVEL=-Onone",
    "SWIFT_COMPILATION_MODE=singlefile",
    "GCC_OPTIMIZATION_LEVEL=0",
    "LLVM_LTO=NO",
    "SWIFT_LTO=NO",
    "DEAD_CODE_STRIPPING=NO",
    "DEPLOYMENT_POSTPROCESSING=NO",
    "STRIP_INSTALLED_PRODUCT=NO",
    "COPY_PHASE_STRIP=NO",
    "DEBUG_INFORMATION_FORMAT=dwarf",
    "COMPILER_INDEX_STORE_ENABLE=NO",
    "ENABLE_TESTABILITY=YES",
  ],
  // Release 公共构建设置项
  RELEASE_BASE_SETTING_LI = [
    "SWIFT_OPTIMIZATION_LEVEL=-O",
    "SWIFT_COMPILATION_MODE=wholemodule",
    "SWIFT_ENFORCE_EXCLUSIVITY=compile-time",
    "GCC_OPTIMIZATION_LEVEL=3",
    "GCC_STRICT_ALIASING=YES",
    "GCC_UNROLL_LOOPS=YES",
    "GCC_INLINES_ARE_PRIVATE_EXTERN=YES",
    "GCC_PREPROCESSOR_DEFINITIONS=" + RELEASE_PREPROC_LI.join(" "),
    "DEAD_CODE_STRIPPING=YES",
    "LD_DONT_RUN_DEDUPLICATION=NO",
    "DEPLOYMENT_POSTPROCESSING=YES",
    "STRIP_INSTALLED_PRODUCT=YES",
    "COPY_PHASE_STRIP=YES",
    "COMPILER_INDEX_STORE_ENABLE=NO",
  ],
  // 组装通用 xcodebuild archive 基础参数列表
  baseArgLiBuild = (mode, archive_path) => [
    "archive",
    "-project",
    join(UTM, "UTM.xcodeproj"),
    "-scheme",
    "macOS",
    "-configuration",
    mode === MODE_DEBUG ? "Debug" : "Release",
    "-destination",
    "generic/platform=macOS",
    "-archivePath",
    archive_path,
    "-derivedDataPath",
    join(BUILD_DIR, MODE_TO_DERIVED[mode]),
    "-jobs",
    String(CPU_N),
    "-skipPackagePluginValidation",
    "-skipMacroValidation",
    "ARCHS=" + ARCH,
    "ONLY_ACTIVE_ARCH=YES",
    "SYSROOT_DIR=build/" + SYSROOT_NAME,
    "CODE_SIGNING_ALLOWED=NO",
  ],
  // 组装 PGO 采样或回填阶段的 [C/C++ 标志列表, Swift 标志列表]
  pgoFlagPairBuild = (is_pgo_gen, pgo_raw_dir, profdata_path) => {
    if (is_pgo_gen) {
      return [
        [
          "-fprofile-generate=" + pgo_raw_dir,
          "-mllvm",
          "-pgo-temporal-instrumentation",
          "-mllvm",
          "-vp-counters-per-site=4",
        ],
        [
          "-Xfrontend",
          "-ir-profile-generate=" + pgo_raw_dir + "/%p_%m.profraw",
          "-Xllvm",
          "-pgo-temporal-instrumentation",
        ],
      ];
    }
    if (!profdata_path) return [[], []];
    return [
      [
        "-fprofile-use=" + profdata_path,
        "-Wno-profile-instr-out-of-date",
        "-Wno-profile-instr-unprofiled",
        "-Wno-backend-plugin",
      ],
      ["-Xfrontend", "-ir-profile-use=" + profdata_path],
    ];
  },
  // 组装 Release / PGO 模式专有构建参数列表
  releaseArgLiBuild = (mode, pgo_raw_dir, profdata_path, order_path) => {
    const is_pgo_gen = mode === MODE_PGO_GEN,
      [pgo_c_li, pgo_swift_li] = pgoFlagPairBuild(is_pgo_gen, pgo_raw_dir, profdata_path),
      c_flag_str = [...RELEASE_C_BASE_LI, ...pgo_c_li].join(" "),
      cxx_flag_str = [
        ...RELEASE_C_BASE_LI,
        "-fstrict-vtable-pointers",
        "-fwhole-program-vtables",
        ...pgo_c_li,
      ].join(" "),
      swift_flag_str = [...RELEASE_SWIFT_BASE_LI, ...pgo_swift_li].join(" "),
      ld_flag_str = (is_pgo_gen ? PGO_GEN_LD_LI : RELEASE_LD_BASE_LI).join(" ");

    return [
      ...RELEASE_BASE_SETTING_LI,
      "LLVM_LTO=" + (is_pgo_gen ? "YES_THIN" : "YES"),
      "OTHER_CFLAGS=" + c_flag_str,
      "OTHER_CPLUSPLUSFLAGS=" + cxx_flag_str,
      "OTHER_SWIFT_FLAGS=" + swift_flag_str,
      "LD_FLAGS=" + ld_flag_str,
      ...(order_path ? ["ORDER_FILE=" + order_path] : []),
    ];
  };

export default (mode, archive_path, pgo_raw_dir = "", profdata_path = "", order_path = "") => [
  ...baseArgLiBuild(mode, archive_path),
  ...(mode === MODE_DEBUG
    ? DEBUG_SETTING_LI
    : releaseArgLiBuild(mode, pgo_raw_dir, profdata_path, order_path)),
];
