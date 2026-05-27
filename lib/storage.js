/**
 * lib/storage.js — Cloudflare R2 ストレージラッパー
 *
 * Vercel Blob の put / head / get / del / list を R2 (S3互換) で再実装。
 * 各APIファイルは require('@vercel/blob') の代わりにこれを使う。
 *
 * 必要な環境変数:
 *   R2_ACCOUNT_ID        — Cloudflare Account ID
 *   R2_ACCESS_KEY_ID     — R2 API トークンのアクセスキー
 *   R2_SECRET_ACCESS_KEY — R2 API トークンのシークレットキー
 *   R2_BUCKET_NAME       — バケット名 (デフォルト: hpb-calendar)
 *   R2_PUBLIC_URL        — パブリックバケットのURL (任意)
 *                          例: https://pub-xxxx.r2.dev
 */

require('dotenv').config();
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const BUCKET = process.env.R2_BUCKET_NAME || 'hpb-calendar';
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

let _client = null;
function getClient() {
  if (_client) return _client;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error('R2_ACCOUNT_ID が .env に未設定です');
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

/**
 * ファイルを保存する
 * @param {string} pathname  — キー名 (例: "slots-data.json")
 * @param {string|object} body — 保存内容
 * @returns {{ url: string, pathname: string }}
 */
async function put(pathname, body) {
  const content = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: pathname,
    Body: content,
    ContentType: 'application/json',
  }));
  const url = PUBLIC_URL ? `${PUBLIC_URL}/${pathname}` : null;
  return { url, pathname };
}

/**
 * ファイルの存在確認・メタデータ取得
 * 存在しない場合は null を返す
 * @returns {{ pathname, size } | null}
 */
async function head(pathname) {
  try {
    const r = await getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: pathname }));
    const url = PUBLIC_URL ? `${PUBLIC_URL}/${pathname}` : null;
    return { pathname, url, size: r.ContentLength, uploadedAt: r.LastModified };
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/**
 * ファイルの内容を JSON として取得
 * 存在しない場合は null を返す
 * @returns {object | null}
 */
async function get(pathname) {
  try {
    const r = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: pathname }));
    const text = await r.Body.transformToString();
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/**
 * ファイルを削除する
 * @param {string} keyOrUrl — キー名 or フルURL
 */
async function del(keyOrUrl) {
  const key = keyOrUrl.startsWith('http')
    ? decodeURIComponent(new URL(keyOrUrl).pathname.replace(/^\//, ''))
    : keyOrUrl;
  await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * ファイル一覧を取得
 * @param {{ prefix?: string }} options
 * @returns {{ blobs: Array<{ pathname, url, size, uploadedAt }> }}
 */
async function list(options = {}) {
  const r = await getClient().send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: options.prefix || '',
  }));
  return {
    blobs: (r.Contents || []).map(obj => ({
      pathname: obj.Key,
      url: PUBLIC_URL ? `${PUBLIC_URL}/${obj.Key}` : null,
      size: obj.Size,
      uploadedAt: obj.LastModified,
    })),
  };
}

module.exports = { put, head, get, del, list };
