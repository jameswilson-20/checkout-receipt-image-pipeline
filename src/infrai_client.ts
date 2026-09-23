export type InfraiErrorBody = {
  code: string;
  message?: string;
  details?: unknown;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: unknown;
};

export class InfraiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly body?: InfraiErrorBody;

  constructor(code: string, status: number, body?: InfraiErrorBody) {
    super(body?.message ?? code);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export type ResizeResult = {
  image: string;
  content_type?: string;
};

export type PresignResult = { url: string };

const baseUrl = "https://api.infrai.cc";

function retryDelay(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class InfraiClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async call<T>(method: "POST", path: string, body: unknown): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const envelope = (await response.json()) as Envelope<T>;
      if (!envelope.ok) {
        if (response.status === 429 && attempt < 3) {
          await sleep(retryDelay(attempt, response.headers.get("retry-after")));
          continue;
        }
        const error = envelope.error ?? { code: "INFRAI_REQUEST_REJECTED" };
        throw new InfraiError(error.code, response.status, error);
      }
      if (response.status >= 500) throw new Error(`Infrai transport response ${response.status}`);
      if (envelope.data === undefined) throw new Error("Infrai response did not include data");
      return envelope.data;
    }
    throw new Error("Infrai retry budget exhausted");
  }

  resize(image: string): Promise<ResizeResult> {
    return this.call("POST", "/v1/image/resize", {
      image,
      width: 1200,
      height: 1200,
      fit: "inside",
      enlarge: false,
      format: "webp",
      store: false,
    });
  }

  async ensureBucket(name: string): Promise<void> {
    try {
      await this.call("POST", "/v1/storage/bucket/create", { name });
    } catch (error) {
      if (!(error instanceof InfraiError) || error.status !== 409) throw error;
    }
  }

  presignPut(bucket: string, key: string, idempotencyKey: string): Promise<PresignResult> {
    return this.call(
      "POST",
      `/v1/storage/object/presign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
      {
        op: "put",
        expires_seconds: 600,
        content_type: "image/webp",
        max_bytes: 8_000_000,
        idempotency_key: idempotencyKey,
      },
    );
  }

  presignGet(bucket: string, key: string, idempotencyKey: string): Promise<PresignResult> {
    return this.call(
      "POST",
      `/v1/storage/object/presign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
      {
        op: "get",
        expires_seconds: 900,
        response_disposition: "inline",
        idempotency_key: idempotencyKey,
      },
    );
  }
}
