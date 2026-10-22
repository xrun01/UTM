#!/usr/bin/env -S bun
// 一键构建 git/UTM (Release 极限性能模式：两阶段 IR-PGO + Temporal Order File + 单线程全模块 CMO + 全局 LTO) 并输出产物至 git/dist

import { MODE_RELEASE } from "./lib/mode.js";
import pipelineRun from "./lib/pipeline.js";

await pipelineRun(MODE_RELEASE);
