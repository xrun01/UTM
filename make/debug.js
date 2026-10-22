#!/usr/bin/env -S bun
// 一键快速构建 git/UTM (Debug 极速增量模式) 并输出产物至 git/dist

import { MODE_DEBUG } from "./lib/mode.js";
import pipelineRun from "./lib/pipeline.js";

await pipelineRun(MODE_DEBUG);
