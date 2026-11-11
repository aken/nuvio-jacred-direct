'use strict';

// Optional network check. No credentials or torrent payloads are requested.
// This script is intentionally excluded from CI: the public service can be
// unavailable, rate-limited, or configured to require authentication.
const url = new URL('https://jacred.su/api/v2.0/indexers/all/results');
url.searchParams.set('query', 'tmdb603');
url.searchParams.set('is_serial', '1');
url.searchParams.set('limit', '5');

const LIMIT = 1024 * 1024;

async function main() {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
    redirect: 'error'
  });
  if (!response.ok) {
    throw new Error('JacRed search returned HTTP ' + response.status +
      (response.status === 401 ? ' (authentication is required by this instance)' : ''));
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) throw new Error('JacRed did not return JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > LIMIT) throw new Error('JacRed response exceeds the 1 MiB Nuvio plugin fetch budget');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!payload || !Array.isArray(payload.Results)) throw new Error('JacRed JSON has no Results array');
  const invalid = payload.Results.some(row => !row || typeof row !== 'object' ||
    typeof row.Title !== 'string' || (row.MagnetUri != null && typeof row.MagnetUri !== 'string'));
  if (invalid) throw new Error('JacRed results include an unexpected field type');
  console.log('JacRed HTTP/JSON contract OK; results: ' + payload.Results.length + '; bytes: ' + size);
  console.log('This checks discovery metadata only, not Samsung playback or episode selection.');
}

main().catch(error => {
  console.error('Live JacRed smoke test failed: ' + (error && error.message || String(error)));
  process.exitCode = 1;
});
