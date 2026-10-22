#!/usr/bin/env -S bun
// git/UTM 仓库根目录路径常量

import { dirname } from "node:path";

export default dirname(dirname(dirname(import.meta.dirname)));
