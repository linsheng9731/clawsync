import path from "node:path";
import fs from "fs-extra";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

function parseS3Uri(uri: string): { bucket: string; prefix: string } {
  if (!uri.startsWith("s3://")) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }
  const rest = uri.slice("s3://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return { bucket: rest, prefix: "" };
  return { bucket: rest.slice(0, slash), prefix: rest.slice(slash + 1).replace(/\/+$/, "") };
}

function buildClient(endpoint?: string, region = process.env.AWS_REGION ?? "us-east-1"): S3Client {
  return new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

export async function pushToS3(archivePath: string, s3Uri: string, endpoint?: string): Promise<string> {
  const { bucket, prefix } = parseS3Uri(s3Uri);
  const client = buildClient(endpoint);
  const key = prefix ? `${prefix}/${path.basename(archivePath)}` : path.basename(archivePath);
  const body = await fs.readFile(archivePath);
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  const latestKey = prefix ? `${prefix}/latest.txt` : "latest.txt";
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: latestKey, Body: path.basename(archivePath) }));
  return `s3://${bucket}/${key}`;
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function pullFromS3(s3Uri: string, outDir: string, endpoint?: string): Promise<string> {
  const { bucket, prefix } = parseS3Uri(s3Uri);
  const client = buildClient(endpoint);
  const latestKey = prefix ? `${prefix}/latest.txt` : "latest.txt";
  let archiveName: string | undefined;

  try {
    const latestResp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: latestKey }));
    archiveName = (await streamToBuffer(latestResp.Body)).toString("utf8").trim();
  } catch {
    const listResp = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined }));
    const names = (listResp.Contents ?? [])
      .map((it) => it.Key ?? "")
      .filter((k) => k.endsWith(".tar.gz"))
      .sort();
    archiveName = names.length > 0 ? path.basename(names[names.length - 1]) : undefined;
  }

  if (!archiveName) throw new Error(`No archive found at ${s3Uri}`);
  const key = prefix ? `${prefix}/${archiveName}` : archiveName;
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buf = await streamToBuffer(resp.Body);
  await fs.ensureDir(outDir);
  const archivePath = path.join(outDir, archiveName);
  await fs.writeFile(archivePath, buf);
  return archivePath;
}
