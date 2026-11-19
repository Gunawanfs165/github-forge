// Entry point: the lifecycle between this forge and the harness env.
//
// The env (started beside this process by the harness) is the only service
// this file talks to. It tells us where to register, waits for the suite to
// finish, and then we exit. The forge itself lives in app.ts; this file only
// boots it, announces its port, and waits for the env to say the trial is
// over.
//
// Lifecycle, in order:
//   1. Read MAKEFUN_ENV_URL. If it is unset there is no env to talk to, so
//      exit 1 at once.
//   2. Start the app server on an ephemeral port with listen(0) and let the
//      kernel pick the port. Never bind 8080: that port belongs to the env.
//   3. POST {"port": <bound port>} as JSON to $MAKEFUN_ENV_URL/register.
//      The env records the caller's address plus that port as our base URL.
//      The first register wins; a later one is answered 409 and does not
//      move the base URL, so 409 counts as success here.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      The env answers immediately ({"done": false} while the suite runs),
//      so this is a poll with a short backoff, never a long-held request.
//      Never exit before it says true.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// A failed register or poll is retried with exponential backoff, because the
// env may still be starting. Only a contract error (register answered 400 or
// 405) ends the program early. This file imports its own server and nothing
// else: no package, no Node built-in, no model call, Node 22 stdlib only.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// How long one register or done request may take before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// First wait between retries, and the longest wait allowed.
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS,
// capped at RETRY_MAX_MS.
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

// POST the bound port until the env accepts it. 200 is the normal answer;
// 409 means a first register already won, which is not this process's to
// fix. 400 and 405 are contract errors and end the program; a network error
// or any other status is retried, since the env may still be starting.
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not
      // done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

// Bind the port, register it, then wait for the env: the whole life of
// this process.
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
