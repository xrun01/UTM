#!/usr/bin/env -S bun
// 纯 JS 非递归目录树遍历纯函数与遍历控制状态码

import { readdirSync } from "node:fs";
import { join } from "node:path";

export const WALK_NEXT = 0,
  WALK_SKIP_DIR = 1,
  WALK_STOP = 2,
  dirWalk = (root_dir, onEntry) => {
    const stack_li = [root_dir];
    while (stack_li.length > 0) {
      const cur_dir = stack_li.pop(),
        entry_li = readdirSync(cur_dir, { withFileTypes: true });
      for (let i = 0; i < entry_li.length; ++i) {
        const entry = entry_li[i],
          full_path = join(cur_dir, entry.name),
          act = onEntry(full_path, entry, cur_dir);
        if (act === WALK_STOP) return full_path;
        if (entry.isDirectory() && act !== WALK_SKIP_DIR) stack_li.push(full_path);
      }
    }
    return "";
  };
