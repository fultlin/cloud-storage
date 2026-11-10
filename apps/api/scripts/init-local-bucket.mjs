import { CreateBucketCommand, HeadBucketCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { setTimeout as delay } from 'node:timers/promises';

const { S3_BUCKET: bucket, S3_ENDPOINT: endpoint, S3_REGION: region, S3_ACCESS_KEY_ID: accessKeyId,
  S3_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
if (bucket !== 'user-files' || !endpoint || !region || !accessKeyId || !secretAccessKey) {
  throw new Error('Local bucket setup requires explicit S3 settings and the user-files bucket');
}
const client = new S3Client({
  endpoint,
  region,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 1,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

function status(error) {
  return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

async function ensureBucket() {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(2000) });
        return;
      } catch (error) {
        if (status(error) !== 404) throw error;
      }
      await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(2000) });
      await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(2000) });
      return;
    } catch (error) {
      const code = status(error);
      // Retry startup and a concurrent create, but fail immediately on invalid credentials.
      if (code !== undefined && code < 500 && ![404, 409, 429].includes(code)) throw error;
      if (attempt === 44) throw error;
      await delay(1000);
    }
  }
}

try {
  await ensureBucket();
  console.info('Local S3 bucket is ready');
} finally {
  client.destroy();
}
