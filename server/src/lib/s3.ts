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

/** 生成浏览器直传对象存储的预签名 PUT URL。 */
export async function createPresignedUploadUrl(config: S3StorageConfig, objectKey: string, contentType: string) {
  const client = createS3Client(config);
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
  const client = createS3Client(config);
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
  });
  return getSignedUrl(client, command, { expiresIn: env.S3_PRESIGN_EXPIRES_SECONDS });
}

export async function headS3Object(config: S3StorageConfig, objectKey: string) {
  const client = createS3Client(config);
  return client.send(
    new HeadObjectCommand({
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
  const client = createS3Client(config);
  return client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function deleteS3Object(config: S3StorageConfig, objectKey: string) {
  const client = createS3Client(config);
  return client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    }),
  );
}

/** 探针式校验对象存储连通性：依次验证桶访问、写入、读取元信息与清理探针文件。 */
export async function testS3Connection(config: S3StorageConfig) {
  const client = createS3Client(config);
  const probeKey = `.infinite-canvas-healthcheck-${nanoid(10)}.txt`;

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
}
