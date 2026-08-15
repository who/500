/**
 * S3-compatible transport for the corpus store (fh-azx.1). The official AWS
 * SDK is forbidden here (zero new runtime deps); Railway buckets speak the
 * S3 REST API, so a small `fetch` + AWS Signature Version 4 client is enough.
 * Tests inject {@link memoryS3Client} and never touch a network.
 */

import { createHash, createHmac } from 'node:crypto';

/** Minimal object-store seam: put/get/list by key. Missing get → null. */
export interface S3Client {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(prefix: string): Promise<string[]>;
}

export interface S3Config {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
}

export interface SignV4Input {
  readonly method: string;
  /** Path beginning with `/`. Each segment is encoded; slashes are kept. */
  readonly canonicalUri: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string | Uint8Array;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service?: string;
  /** `YYYYMMDD'T'HHMMSS'Z'`, e.g. `20130524T000000Z`. */
  readonly amzDate: string;
}

export interface SignV4Result {
  readonly authorization: string;
  readonly signature: string;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signedHeaders: string;
  readonly contentSha256: string;
  readonly credentialScope: string;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** RFC 3986 encode: unreserved chars stay literal; `/` only if `encodeSlash`. */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const ch of value) {
    if (
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '-' ||
      ch === '_' ||
      ch === '.' ||
      ch === '~'
    ) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += '/';
    } else {
      const bytes = Buffer.from(ch, 'utf8');
      for (const b of bytes) {
        out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function payloadBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
}

function payloadSha256(payload: string | Uint8Array): string {
  const bytes = payloadBytes(payload);
  if (bytes.length === 0) return EMPTY_SHA256;
  return sha256Hex(bytes);
}

function canonicalQuery(query: Readonly<Record<string, string>> | undefined): string {
  if (query === undefined) return '';
  const parts = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k] ?? '')}`);
  return parts.join('&');
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Sign a request with AWS Signature Version 4 (header-based). Pure: no clock,
 * no I/O. Used by {@link fetchS3Client} and covered by the AWS GET-Object
 * fixture in store.test.ts.
 */
export function signV4(input: SignV4Input): SignV4Result {
  const service = input.service ?? 's3';
  const contentSha256 =
    headerOf(input.headers, 'x-amz-content-sha256') ?? payloadSha256(input.payload);
  const amzDate = headerOf(input.headers, 'x-amz-date') ?? input.amzDate;
  const dateStamp = amzDate.slice(0, 8);

  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    merged[k.toLowerCase()] = normalizeHeaderValue(v);
  }
  merged['x-amz-content-sha256'] = contentSha256;
  merged['x-amz-date'] = amzDate;

  const signedNames = Object.keys(merged).sort();
  const signedHeaders = signedNames.join(';');
  const canonicalHeaders = signedNames.map((n) => `${n}:${merged[n]}\n`).join('');

  const canonicalRequest = [
    input.method.toUpperCase(),
    uriEncode(input.canonicalUri, false),
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    contentSha256,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    signature,
    canonicalRequest,
    stringToSign,
    signedHeaders,
    contentSha256,
    credentialScope,
  };
}

function headerOf(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/** In-memory {@link S3Client} for tests — same seam as the fetch client. */
export function memoryS3Client(initial?: Readonly<Record<string, string>>): S3Client {
  const objects = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      return objects.has(key) ? (objects.get(key) as string) : null;
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

export interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface FetchS3Options {
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

function amzNow(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function objectPath(bucket: string, key: string): string {
  const encoded = key
    .split('/')
    .map((seg) => uriEncode(seg))
    .join('/');
  return `/${uriEncode(bucket)}/${encoded}`;
}

function endpointUrl(endpoint: string, path: string, query?: Readonly<Record<string, string>>): string {
  const base = endpoint.replace(/\/$/, '');
  const qs = canonicalQuery(query);
  return qs.length > 0 ? `${base}${path}?${qs}` : `${base}${path}`;
}

function hostOf(endpoint: string): string {
  const u = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
  return u.host;
}

function parseListKeys(xml: string): { keys: string[]; nextToken: string | null } {
  const keys: string[] = [];
  const keyRe = /<Key>([^<]*)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(xml)) !== null) {
    keys.push(decodeXml(m[1] ?? ''));
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tokenMatch = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
  const nextToken = truncated && tokenMatch?.[1] !== undefined ? decodeXml(tokenMatch[1]) : null;
  return { keys, nextToken };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Path-style S3 REST client over `fetch`. Signs every request with
 * {@link signV4}. Inject `fetch` / `now` to keep tests offline and deterministic.
 */
export function fetchS3Client(config: S3Config, options: FetchS3Options = {}): S3Client {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const now = options.now ?? (() => new Date());
  const host = hostOf(config.endpoint);

  async function signed(
    method: string,
    keyOrEmpty: string,
    query: Record<string, string> | undefined,
    body: string,
  ): Promise<{ status: number; text: string }> {
    const path = keyOrEmpty === '' ? `/${uriEncode(config.bucket)}` : objectPath(config.bucket, keyOrEmpty);
    const amzDate = amzNow(now());
    const headers: Record<string, string> = { host };
    const signed = signV4({
      method,
      canonicalUri: path,
      query,
      headers,
      payload: body,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      amzDate,
    });
    const reqHeaders: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': signed.contentSha256,
      authorization: signed.authorization,
    };
    const res = await fetchImpl(endpointUrl(config.endpoint, path, query), {
      method,
      headers: reqHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  return {
    async put(key, body) {
      const res = await signed('PUT', key, undefined, body);
      if (res.status !== 200 && res.status !== 204) {
        throw new Error(`s3 put ${key}: HTTP ${res.status}`);
      }
    },
    async get(key) {
      const res = await signed('GET', key, undefined, '');
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`s3 get ${key}: HTTP ${res.status}`);
      return res.text;
    },
    async list(prefix) {
      const out: string[] = [];
      let token: string | undefined;
      for (;;) {
        const query: Record<string, string> = { 'list-type': '2', prefix };
        if (token !== undefined) query['continuation-token'] = token;
        const res = await signed('GET', '', query, '');
        if (res.status !== 200) throw new Error(`s3 list ${prefix}: HTTP ${res.status}`);
        const parsed = parseListKeys(res.text);
        out.push(...parsed.keys);
        if (parsed.nextToken === null) break;
        token = parsed.nextToken;
      }
      return out;
    },
  };
}
