/** S3 兼容对象存储（R2 / 阿里云 OSS / 腾讯云 COS / MinIO）预签名与对象操作封装。 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { nanoid } from "nanoid";

import { env } from "../env.ts";
import type { S3StorageConfig } from "./settings.ts";

let cachedS3Fingerprint = "";
let cachedS3Client: S3Client | null = null;

function s3ConfigFingerprint(config: S3StorageConfig) {
  return JSON.stringify([
    config.provider,
    config.endpoint || "",
    config.region || "auto",
    config.bucket,
    config.accessKeyId,
    config.secretAccessKey,
    Boolean(config.forcePathStyle),
  ]);
}

/** 根据当前平台对象存储配置构造 S3 客户端。 */
export function createS3Client(config: S3StorageConfig) {
  return new S3Client({
    region: config.region || "auto",
    endpoint: config.endpoint || undefined,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/** 按配置指纹复用进程内 S3Client 实例，避免高并发下频繁重建客户端与 TLS 连接。 */
function getReusableS3Client(config: S3StorageConfig) {
  const fingerprint = s3ConfigFingerprint(config);
  if (cachedS3Client && cachedS3Fingerprint === fingerprint) {
    return cachedS3Client;
  }
  const previous = cachedS3Client;
  cachedS3Client = createS3Client(config);
  cachedS3Fingerprint = fingerprint;
  if (previous) {
    try {
      previous.destroy();
    } catch {
      // ignore destroy error on previous client
    }
  }
  return cachedS3Client;
}

/** 生成浏览器直传对象存储的预签名 PUT URL。 */
export async function createPresignedUploadUrl(config: S3StorageConfig, objectKey: string, contentType: string) {
  const client = getReusableS3Client(config);
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn: env.S3_PRESIGN_EXPIRES_SECONDS });
}

/** 生成媒体读取地址：配置了自定义公网域名时直接拼接，否则返回签名 GET URL。 */
export async function createMediaReadUrl(config: S3StorageConfig, objectKey: string) {
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/${objectKey}`;
  }
  const client = getReusableS3Client(config);
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
  });
  return getSignedUrl(client, command, { expiresIn: env.S3_PRESIGN_EXPIRES_SECONDS });
}

export async function headS3Object(config: S3StorageConfig, objectKey: string) {
  const client = getReusableS3Client(config);
  return client.send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    }),
  );
}

/** 从对象存储读取对象流，供鉴权后的同源下载代理使用。 */
export async function getS3Object(config: S3StorageConfig, objectKey: string) {
  const client = getReusableS3Client(config);
  return client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    }),
  );
}

export async function putS3Object(
  config: S3StorageConfig,
  objectKey: string,
  body: Uint8Array | Buffer | string,
  contentType: string,
) {
  const client = getReusableS3Client(config);
  return client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export function isS3NotFoundError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const code = String(err.name || err.Code || err.code || "");
  return code === "NoSuchKey" || code === "NotFound" || err.$metadata?.httpStatusCode === 404;
}

export async function deleteS3Object(config: S3StorageConfig, objectKey: string) {
  const client = getReusableS3Client(config);
  return client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    }),
  );
}

/** 严格删除 S3/MinIO 对象：对象已不存在（404/NoSuchKey）视为已删除，其余错误向上抛出以避免误标数据库状态。 */
export async function deleteS3ObjectStrict(config: S3StorageConfig, objectKey: string) {
  try {
    await deleteS3Object(config, objectKey);
  } catch (error) {
    if (isS3NotFoundError(error)) return;
    throw error;
  }
}

/** 探针式校验对象存储连通性：依次验证桶访问、写入、读取元信息与清理探针文件。 */
export async function testS3Connection(config: S3StorageConfig) {
  const client = createS3Client(config);
  const probeKey = `.infinite-canvas-healthcheck-${nanoid(10)}.txt`;

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: probeKey,
        Body: "infinite-canvas healthcheck",
        ContentType: "text/plain",
      }),
    );
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: probeKey }));
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: probeKey }));
  } finally {
    client.destroy();
  }
}
