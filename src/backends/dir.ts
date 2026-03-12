import path from "node:path";
import fs from "fs-extra";

export async function pushToDir(archivePath: string, toDir: string): Promise<string> {
  const targetDir = path.resolve(toDir);
  await fs.ensureDir(targetDir);
  const targetFile = path.join(targetDir, path.basename(archivePath));
  await fs.copyFile(archivePath, targetFile);
  const latestFile = path.join(targetDir, "latest.txt");
  await fs.writeFile(latestFile, path.basename(targetFile), "utf8");
  return targetFile;
}

export async function resolveFromDir(inputPath: string): Promise<string> {
  const source = path.resolve(inputPath);
  const stat = await fs.stat(source);
  if (stat.isFile()) return source;

  const latestFile = path.join(source, "latest.txt");
  if (await fs.pathExists(latestFile)) {
    const name = (await fs.readFile(latestFile, "utf8")).trim();
    return path.join(source, name);
  }

  const files = (await fs.readdir(source))
    .filter((f) => f.endsWith(".tar.gz"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .tar.gz archive found in directory: ${source}`);
  }
  return path.join(source, files[files.length - 1]);
}
