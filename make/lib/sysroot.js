#!/usr/bin/env -S bun
// UTM macOS 预编译依赖包(build/sysroot-macOS-<arch>)检查、GitHub Actions 自动拉取与本地构建回退

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BUILD_DIR, SYSROOT_DIR, SYSROOT_NAME } from "./dir/BUILD.js";
import { env$, quiet$, run$ } from "./sh.js";
import ARCH from "./sys/ARCH.js";
import CPU_N from "./sys/CPU_N.js";

const ARTIFACT_NAME = "Sysroot-macos-" + ARCH,
  ARTIFACT_QUERY = "repos/utmapp/UTM/actions/artifacts?name=" + ARTIFACT_NAME + "&per_page=5",
  ARTIFACT_JQ = "[.artifacts[] | select(.expired == false)][0].workflow_run.id // empty",
  sysrootHas = () => existsSync(join(SYSROOT_DIR, "lib")),
  sysrootArtifactDownload = async (tmp_dir) => {
    console.log("未检测到预编译依赖目录，正在查询 GitHub Actions 产物: " + ARTIFACT_NAME);
    const { exitCode: gh_ok, stdout: run_id_out } =
        await quiet$`gh api ${ARTIFACT_QUERY} --jq ${ARTIFACT_JQ}`.nothrow(),
      run_id = gh_ok === 0 ? run_id_out.trim() : "";
    if (!run_id) return;

    const dl_dir = join(tmp_dir, "sysroot_dl"),
      tgz_path = join(dl_dir, "sysroot.tgz");
    mkdirSync(dl_dir, { recursive: true });
    console.log("正在从 utmapp/UTM (运行编号 " + run_id + ") 下载 " + ARTIFACT_NAME + "...");
    const { exitCode: dl_code } =
      await run$`gh run download ${run_id} -R utmapp/UTM -n ${ARTIFACT_NAME} -D ${dl_dir}`.nothrow();
    if (dl_code === 0 && existsSync(tgz_path)) {
      console.log("正在解压 " + ARTIFACT_NAME + " 至 git/UTM/build/" + SYSROOT_NAME + "...");
      mkdirSync(SYSROOT_DIR, { recursive: true });
      await run$`tar -xf ${tgz_path} --strip-components=1 -C ${SYSROOT_DIR}`;
    }
  },
  sysrootLocalBuild = async () => {
    console.log("预编译产物未命中，正在本地构建 macOS (" + ARCH + ") 依赖库...");
    const dep$ = env$({ NCPU: String(CPU_N) }, BUILD_DIR);
    await dep$`../scripts/build_dependencies.sh -p macos -a ${ARCH}`;
  };

export default async (tmp_dir) => {
  mkdirSync(BUILD_DIR, { recursive: true });
  if (sysrootHas()) return;
  await sysrootArtifactDownload(tmp_dir);
  if (!sysrootHas()) await sysrootLocalBuild();
};
