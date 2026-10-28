import fs from 'node:fs/promises';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const directory = path.resolve(process.env.UPLOAD_DIR || './var/uploads');
const bucket = process.env.S3_BUCKET;
const prefix = (process.env.S3_PREFIX || 'quotient/').replace(/^\/+|\/+$/g, '') + '/';
let client: S3Client | undefined;
function storageClient() {
  return (client ??= new S3Client({ region: process.env.AWS_REGION || 'us-east-1' }));
}
/** Photos are JPEGs and logos PNGs. Old quotes and invoices waiting to be read can be PDFs. */
function safeKey(key: string) {
  if (!/^[0-9a-f-]{36}\.(jpg|png|pdf)$/.test(key)) throw new Error('Invalid private storage key.');
  return key;
}
const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' } as const;
export async function putPhoto(key: string, photo: Buffer): Promise<void> {
  const name = safeKey(key);
  if (bucket) {
    await storageClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: prefix + name,
        Body: photo,
        ContentType: CONTENT_TYPES[name.slice(-3) as keyof typeof CONTENT_TYPES],
        ServerSideEncryption: 'AES256',
      }),
    );
  } else {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, name), photo, { mode: 0o600, flag: 'wx' });
  }
}
export async function getPhoto(key: string): Promise<Buffer> {
  const name = safeKey(key);
  if (bucket) {
    const response = await storageClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: prefix + name }),
    );
    if (!response.Body) throw new Error('Private image is unavailable.');
    return Buffer.from(await response.Body.transformToByteArray());
  }
  return fs.readFile(path.join(directory, name));
}
export async function deletePhoto(key: string): Promise<void> {
  const name = safeKey(key);
  if (bucket)
    await storageClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: prefix + name }));
  else
    await fs.unlink(path.join(directory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
}
