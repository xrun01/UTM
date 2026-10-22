#!/usr/bin/env -S bun
// Debug 与 Release 共享端到端构建流水线

import { join } from "node:path";
import archiveBuild from "./archive.js";
import depEnsure from "./dep.js";
import { MODE_RELEASE, MODE_TO_SUB, MODE_TO_TAG } from "./mode.js";
import pgoProfileEnsure from "./pgo.js";
import { distAppStage } from "./sign.js";
import sysrootEnsure from "./sysroot.js";
import tmpDirInit from "./tmp.js";

export default async (mode) => {
  const mode_sub = MODE_TO_SUB[mode],
    mode_tag = MODE_TO_TAG[mode];

  using tmp = tmpDirInit("utm_" + mode_sub);
  await depEnsure();
  await sysrootEnsure(tmp.dir_path);

  const [profdata_path, order_path] =
      mode === MODE_RELEASE ? await pgoProfileEnsure(tmp.dir_path) : ["", ""],
    archive_path = join(tmp.dir_path, "UTM.xcarchive"),
    built_app = await archiveBuild(mode, archive_path, "", profdata_path, order_path),
    [dist_app, dist_cli] = await distAppStage(built_app, tmp.dir_path, mode_sub);

  console.log("UTM " + mode_tag + " 构建完成 -> 应用包: " + dist_app + " | 命令行: " + dist_cli);
};
