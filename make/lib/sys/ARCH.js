#!/usr/bin/env -S bun
// 主机默认目标编译架构常量 (arm64 / x86_64)

import { arch } from "node:os";

export default arch() === "x64" ? "x86_64" : "arm64";
