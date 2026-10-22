#!/usr/bin/env -S bun
// git/UTM 构建中间缓存目录及子目录路径常量 (git/UTM/build)

import { join } from "node:path";
import ARCH from "../sys/ARCH.js";
import UTM from "./UTM.js";

export const BUILD_DIR = join(UTM, "build"),
  SYSROOT_NAME = "sysroot-macOS-" + ARCH,
  SYSROOT_DIR = join(BUILD_DIR, SYSROOT_NAME),
  PGO_DIR = join(BUILD_DIR, "pgo");
