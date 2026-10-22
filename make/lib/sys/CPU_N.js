#!/usr/bin/env -S bun
// 主机默认逻辑 CPU 核心数常量

import { cpus } from "node:os";

export default cpus().length;
