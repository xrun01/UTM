// 同步执行外部命令；失败时抛出带完整输出的错误

export const run = (cmd, ...args) => {
  const proc = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" }),
    stdout = proc.stdout.toString(),
    stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) {
    throw new Error(
      "命令执行失败(" + proc.exitCode + "): " + [cmd, ...args].join(" ") + "\n" + (stderr || stdout).trim(),
    );
  }
  return stdout;
};

export const xcrun = (...args) => run("xcrun", ...args);

// 用 plutil 把 plist 或旧式 .strings 文件转成 JS 对象
export const plistOf = (path) => JSON.parse(run("plutil", "-convert", "json", "-o", "-", path));
