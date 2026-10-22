#!/usr/bin/env -S bun
// 构建模式枚举常量与模式元数据映射

export const MODE_DEBUG = 1,
  MODE_RELEASE = 2,
  MODE_PGO_GEN = 3,
  MODE_TO_SUB = {
    [MODE_DEBUG]: "debug",
    [MODE_RELEASE]: "release",
  },
  MODE_TO_TAG = {
    [MODE_DEBUG]: "Debug",
    [MODE_RELEASE]: "Release",
  },
  MODE_TO_DERIVED = {
    [MODE_DEBUG]: "DerivedData-Debug",
    [MODE_RELEASE]: "DerivedData-Release",
    [MODE_PGO_GEN]: "DerivedData-PGO",
  },
  MODE_TO_LABEL = {
    [MODE_DEBUG]: "Debug 极速增量",
    [MODE_RELEASE]: "Release 极限性能优化",
    [MODE_PGO_GEN]: "Release PGO+Temporal 采样插桩",
  };
