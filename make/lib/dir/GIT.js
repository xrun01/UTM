#!/usr/bin/env -S bun
// git 子目录路径常量

import { dirname } from "node:path";
import UTM from "./UTM.js";

export default dirname(UTM);
