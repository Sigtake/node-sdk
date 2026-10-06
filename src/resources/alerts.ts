import { localValidationError } from '../errors.js';
import { ensureOk, type HttpClient } from '../http.js';
import type { IngestAlertInput, IngestAlertResponse, RequestOptions } from '../types.js';

const PAYLOAD_MAX_LENGTH = 8192;
const LINKS_MAX = 5;
const LINK_LABEL_MAX_LENGTH = 80;
const LINK_URL_MAX_LENGTH = 1024;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export class AlertsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Sends an alert to `POST /api/ingest`.
   *
   * The alert is deduplicated server-side on `source|title|severity` within the
   * key's project: an open alert with the same fingerprint gets its occurrence
   * count bumped instead of creating a second incident.
   */
  async ingest(input: IngestAlertInput, options?: RequestOptions): Promise<IngestAlertResponse> {
    validateAlert(input);

    const response = await this.http.post(
      '/api/ingest',
      {
        title: input.title,
        source: input.source,
        team_code: input.team_code,
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        ...(input.links === undefined ? {} : { links: input.links }),
      },
      options ?? {},
    );

    ensureOk(response);
    return response.body as IngestAlertResponse;
  }
}

function validateAlert(input: IngestAlertInput): void {
  if (typeof input?.title !== 'string' || input.title.length < 1 || input.title.length > 500) {
    throw localValidationError('title must be a string between 1 and 500 characters');
  }
  if (typeof input.source !== 'string' || input.source.length < 1 || input.source.length > 255) {
    throw localValidationError('source must be a string between 1 and 255 characters');
  }
  if (
    typeof input.team_code !== 'string' ||
    input.team_code.length < 1 ||
    input.team_code.length > 12
  ) {
    throw localValidationError('team_code must be a string between 1 and 12 characters');
  }
  if (input.payload !== undefined) {
    if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload)) {
      throw localValidationError('payload must be a plain object');
    }
    // Measured the same way the server does: JSON string length, not UTF-8 bytes.
    if (JSON.stringify(input.payload).length > PAYLOAD_MAX_LENGTH) {
      throw localValidationError(`payload exceeds the ${PAYLOAD_MAX_LENGTH} character limit`);
    }
  }
  if (input.links !== undefined) {
    validateLinks(input.links);
  }
}

// Same rules as the server, measured on the trimmed value. Duplicate URLs are left
// for the server to drop rather than rejected here.
function validateLinks(links: unknown): void {
  if (!Array.isArray(links)) {
    throw localValidationError('links must be an array');
  }
  if (links.length > LINKS_MAX) {
    throw localValidationError(`links accepts at most ${LINKS_MAX} entries`);
  }
  links.forEach((link: unknown, i) => {
    const { label, url } = (link ?? {}) as { label?: unknown; url?: unknown };
    if (typeof label !== 'string' || typeof url !== 'string') {
      throw localValidationError(`links[${i}] must be an object with string label and url`);
    }
    const trimmedLabel = label.trim();
    if (
      trimmedLabel.length < 1 ||
      trimmedLabel.length > LINK_LABEL_MAX_LENGTH ||
      CONTROL_CHARS.test(trimmedLabel)
    ) {
      throw localValidationError(
        `links[${i}].label must be 1 to ${LINK_LABEL_MAX_LENGTH} characters without control characters`,
      );
    }
    if (!isAllowedLinkUrl(url.trim())) {
      throw localValidationError(
        `links[${i}].url must be an http(s) URL without credentials, up to ${LINK_URL_MAX_LENGTH} characters`,
      );
    }
  });
}

function isAllowedLinkUrl(url: string): boolean {
  if (url.length > LINK_URL_MAX_LENGTH || CONTROL_CHARS.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !parsed.username && !parsed.password;
}
