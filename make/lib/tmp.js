#!/usr/bin/env -S bun
// 基于 Symbol.dispose 的系统临时目录 /tmp/xvm 自动创建与退出清理守卫

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_XVM_DIR = join(tmpdir(), "xvm");

export default (prefix = "utm_make") => {
  const dir_path = join(TMP_XVM_DIR, prefix + "_" + process.pid);
  rmSync(dir_path, { recursive: true, force: true });
  mkdirSync(dir_path, { recursive: true });
  return {
    dir_path,
    [Symbol.dispose]: () => {
      rmSync(dir_path, { recursive: true, force: true });
    },
  };
};
