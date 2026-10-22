#!/usr/bin/env -S bun
// 构建产物输出目录路径常量 (git/dist)

import { join } from "node:path";
import GIT from "./GIT.js";

export default join(GIT, "dist");
