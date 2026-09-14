interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * Education Data MCP — US K-12 schools, districts, funding and child poverty.
 *
 * Source: the Urban Institute Education Data API
 * (https://educationdata.urban.org), which harmonises the federal K-12 sources —
 * NCES Common Core of Data (CCD), the Civil Rights Data Collection, and Census
 * SAIPE poverty estimates — into one queryable API. Keyless, no registration.
 *
 * Why this pack: `college-scorecard` already covers HIGHER education
 * (institutions, cost, outcomes). Nothing covered K-12 — schools, districts,
 * per-pupil spending, or district child poverty — which is where US education
 * questions actually concentrate.
 *
 * Tools:
 * - education_find_schools: individual K-12 schools by state/city/name
 * - education_find_districts: school districts by state/name
 * - education_district_finance: district revenue + spending, incl. per-pupil
 * - education_child_poverty: Census SAIPE child poverty by district
 */


const BASE = 'https://educationdata.urban.org/api/v1';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

/** State/territory → Census FIPS, which is how the API filters geography. */
const STATE_FIPS: Record<string, number> = {
  AL: 1, AK: 2, AZ: 4, AR: 5, CA: 6, CO: 8, CT: 9, DE: 10, DC: 11, FL: 12, GA: 13,
  HI: 15, ID: 16, IL: 17, IN: 18, IA: 19, KS: 20, KY: 21, LA: 22, ME: 23, MD: 24,
  MA: 25, MI: 26, MN: 27, MS: 28, MO: 29, MT: 30, NE: 31, NV: 32, NH: 33, NJ: 34,
  NM: 35, NY: 36, NC: 37, ND: 38, OH: 39, OK: 40, OR: 41, PA: 42, RI: 44, SC: 45,
  SD: 46, TN: 47, TX: 48, UT: 49, VT: 50, VA: 51, WA: 53, WV: 54, WI: 55, WY: 56,
  PR: 72,
};
const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', 'washington dc': 'DC', florida: 'FL',
  georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};

function resolveFips(state: string): number {
  const raw = state.trim();
  const abbr = raw.length === 2 ? raw.toUpperCase() : STATE_NAMES[raw.toLowerCase()];
  const fips = abbr ? STATE_FIPS[abbr] : undefined;
  if (!fips) {
    throw new Error(
      `Unknown state "${state}". Pass a US state name ("Colorado") or 2-letter abbreviation ("CO").`,
    );
  }
  return fips;
}

interface ApiPage {
  count?: number;
  next?: string | null;
  results?: Record<string, unknown>[];
}

async function eduGet(path: string, params: Record<string, string | number | undefined>): Promise<ApiPage> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const url = `${BASE}/${path}?${qs}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 404) {
    throw new Error(
      `No Education Data endpoint for that combination (HTTP 404) — usually the year isn't published for this dataset. Try an earlier year.`,
    );
  }
  if (!res.ok) throw await httpError(res, 'Urban Institute Education Data API error');
  return (await res.json()) as ApiPage;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  // The API uses negative sentinels (-1, -2, -3) for suppressed/missing values.
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function clampLimit(v: unknown, dflt: number, max = 100): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : dflt;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'education_find_schools',
    description:
      'Find US K-12 PUBLIC SCHOOLS by state, with optional city or name filter. Keyless federal data (NCES Common Core of Data via the Urban Institute). Returns each school\'s NCES id, name, district, city, enrollment, charter/magnet status, grade range, and free/reduced-price lunch counts. Use for "public schools in <city/state>", "how many students at <school>", "charter schools in <state>", "which schools have the highest enrollment". For school DISTRICTS use education_find_districts; for COLLEGES use the college-scorecard pack instead — this covers K-12 only.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'US state name or 2-letter abbreviation, e.g. "Colorado" or "CO". Required.' },
        city: { type: 'string', description: 'Optional city filter, matched case-insensitively against the school\'s city.' },
        name_contains: { type: 'string', description: 'Optional substring match on the school name, e.g. "Lincoln".' },
        charter_only: { type: 'boolean', description: 'Return only charter schools.' },
        year: { type: 'number', description: 'School year (data year). Default 2020.' },
        limit: { type: 'number', description: 'Max schools to return (1-100, default 25).' },
      },
      required: ['state'],
    },
  },
  {
    name: 'education_find_districts',
    description:
      'Find US PUBLIC SCHOOL DISTRICTS (local education agencies) by state, with optional name filter. Keyless federal data (NCES Common Core of Data). Returns each district\'s LEA id, name, county, city, number of schools, enrollment, and teacher counts. Use for "school districts in <state>", "how big is <district>", "how many students does <district> serve". The returned leaid feeds education_district_finance and education_child_poverty.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'US state name or 2-letter abbreviation. Required.' },
        name_contains: { type: 'string', description: 'Optional substring match on district name, e.g. "Denver".' },
        year: { type: 'number', description: 'Data year. Default 2020.' },
        limit: { type: 'number', description: 'Max districts to return (1-100, default 25).' },
      },
      required: ['state'],
    },
  },
  {
    name: 'education_district_finance',
    description:
      'School district FUNDING AND SPENDING — revenue by source (federal / state / local) and expenditure by function, plus computed PER-PUPIL spending. Keyless federal data (NCES CCD school district finance survey, F-33). Use for "how much does <district> spend per student", "school funding by district in <state>", "which districts get the most federal money", "local vs state share of school funding". Pass a state to rank districts, or a leaid (from education_find_districts) for one district. Note the finance survey lags the directory data by 1-2 years.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'US state name or 2-letter abbreviation. Required unless leaid is given.' },
        leaid: { type: 'string', description: 'Specific district LEA id from education_find_districts.' },
        year: { type: 'number', description: 'Fiscal year. Default 2019 (the finance survey lags).' },
        sort_by: {
          type: 'string',
          enum: ['per_pupil_spending', 'total_revenue', 'total_expenditure', 'federal_revenue'],
          description: 'Ranking field, largest first. Default per_pupil_spending.',
        },
        limit: { type: 'number', description: 'Max districts to return (1-100, default 25).' },
      },
    },
  },
  {
    name: 'education_child_poverty',
    description:
      'CHILD POVERTY by school district — Census SAIPE estimates of the number and percentage of school-age children (5-17) in poverty, which drive federal Title I funding. Keyless. Use for "child poverty rate in <district>", "poorest school districts in <state>", "how many students in poverty in <district>". Pass a state to rank districts by poverty rate, or a leaid for one district.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'US state name or 2-letter abbreviation. Required unless leaid is given.' },
        leaid: { type: 'string', description: 'Specific district LEA id from education_find_districts.' },
        year: { type: 'number', description: 'Estimate year. Default 2020.' },
        limit: { type: 'number', description: 'Max districts to return (1-100, default 25).' },
      },
    },
  },
];

async function findSchools(args: Record<string, unknown>) {
  const fips = resolveFips(String(args.state ?? ''));
  const year = Math.floor(Number(args.year) || 2020);
  const limit = clampLimit(args.limit, 25);
  const city = str(args.city)?.toLowerCase();
  const nameNeedle = str(args.name_contains)?.toLowerCase();

  // Filter client-side (the API has no name/city predicate), so pull a wider
  // page than the caller asked for — but bounded, to avoid a huge payload.
  const page = await eduGet(`schools/ccd/directory/${year}/`, { fips, limit: city || nameNeedle ? 500 : limit });
  let rows = page.results ?? [];
  if (city) rows = rows.filter((r) => String(r.city_location ?? '').toLowerCase() === city);
  if (nameNeedle) rows = rows.filter((r) => String(r.school_name ?? '').toLowerCase().includes(nameNeedle));
  if (args.charter_only === true) rows = rows.filter((r) => Number(r.charter) === 1);

  return {
    state: String(args.state),
    year,
    total_in_state: page.count ?? null,
    count: Math.min(rows.length, limit),
    schools: rows.slice(0, limit).map((r) => ({
      ncessch: str(r.ncessch),
      school_name: str(r.school_name),
      district_name: str(r.lea_name),
      leaid: str(r.leaid),
      city: str(r.city_location),
      enrollment: num(r.enrollment),
      charter: Number(r.charter) === 1,
      magnet: Number(r.magnet) === 1,
      lowest_grade: str(r.lowest_grade_offered),
      highest_grade: str(r.highest_grade_offered),
      free_or_reduced_price_lunch: num(r.free_or_reduced_price_lunch),
    })),
  };
}

async function findDistricts(args: Record<string, unknown>) {
  const fips = resolveFips(String(args.state ?? ''));
  const year = Math.floor(Number(args.year) || 2020);
  const limit = clampLimit(args.limit, 25);
  const nameNeedle = str(args.name_contains)?.toLowerCase();

  const page = await eduGet(`school-districts/ccd/directory/${year}/`, { fips, limit: nameNeedle ? 500 : limit });
  let rows = page.results ?? [];
  if (nameNeedle) rows = rows.filter((r) => String(r.lea_name ?? '').toLowerCase().includes(nameNeedle));

  return {
    state: String(args.state),
    year,
    total_in_state: page.count ?? null,
    count: Math.min(rows.length, limit),
    districts: rows.slice(0, limit).map((r) => ({
      leaid: str(r.leaid),
      district_name: str(r.lea_name),
      county: str(r.county_name),
      city: str(r.city_location),
      enrollment: num(r.enrollment),
      number_of_schools: num(r.number_of_schools),
      teachers_fte: num(r.teachers_total_fte),
      charter_agency: Number(r.agency_charter_indicator) === 1,
    })),
  };
}

async function districtFinance(args: Record<string, unknown>) {
  const leaid = str(args.leaid);
  const stateArg = str(args.state);
  if (!leaid && !stateArg) {
    throw new Error('Pass either "state" (to rank districts) or "leaid" (for one district). Get a leaid from education_find_districts.');
  }
  const year = Math.floor(Number(args.year) || 2019);
  const limit = clampLimit(args.limit, 25);
  const sortBy = str(args.sort_by) ?? 'per_pupil_spending';

  // The finance record carries 163 fields; project to the ones that answer
  // funding questions rather than returning the whole survey.
  const page = await eduGet(`school-districts/ccd/finance/${year}/`, {
    fips: stateArg ? resolveFips(stateArg) : undefined,
    leaid: leaid ?? undefined,
    limit: leaid ? 10 : 500,
  });

  const rows = (page.results ?? []).map((r) => {
    const enrollment = num(r.enrollment_fall_responsible);
    const current = num(r.exp_current_elsec_total);
    return {
      leaid: str(r.leaid),
      year: num(r.year),
      enrollment,
      total_revenue: num(r.rev_total),
      federal_revenue: num(r.rev_fed_total),
      state_revenue: num(r.rev_state_total),
      local_revenue: num(r.rev_local_total),
      local_property_tax: num(r.rev_local_prop_tax),
      total_expenditure: num(r.exp_total),
      current_spending: current,
      instruction_spending: num(r.exp_current_instruction_total),
      capital_outlay: num(r.outlay_capital_total),
      per_pupil_spending:
        current !== null && enrollment !== null && enrollment > 0
          ? Math.round(current / enrollment)
          : null,
    };
  });

  const key = sortBy === 'total_revenue' ? 'total_revenue'
    : sortBy === 'total_expenditure' ? 'total_expenditure'
    : sortBy === 'federal_revenue' ? 'federal_revenue'
    : 'per_pupil_spending';
  rows.sort((a, b) => (Number(b[key as keyof typeof b] ?? 0)) - (Number(a[key as keyof typeof a] ?? 0)));

  return {
    state: stateArg ?? null,
    leaid: leaid ?? null,
    year,
    sorted_by: key,
    count: Math.min(rows.length, limit),
    note: 'Dollar figures are as reported to the NCES F-33 school district finance survey. per_pupil_spending = current spending / fall enrollment. Suppressed or missing values are returned as null rather than the API\'s negative sentinels.',
    districts: rows.slice(0, limit),
  };
}

async function childPoverty(args: Record<string, unknown>) {
  const leaid = str(args.leaid);
  const stateArg = str(args.state);
  if (!leaid && !stateArg) {
    throw new Error('Pass either "state" (to rank districts) or "leaid" (for one district). Get a leaid from education_find_districts.');
  }
  const year = Math.floor(Number(args.year) || 2020);
  const limit = clampLimit(args.limit, 25);

  const page = await eduGet(`school-districts/saipe/${year}/`, {
    fips: stateArg ? resolveFips(stateArg) : undefined,
    leaid: leaid ?? undefined,
    limit: leaid ? 10 : 500,
  });

  const rows = (page.results ?? []).map((r) => {
    // SAIPE's *_pct field is a PROPORTION, not a percentage: Academy School
    // District 20 reports 0.046175 for 1,058 of 22,913 children = 4.62%.
    // Returning it unconverted under a "_pct" name would have agents reporting
    // child poverty 100x too low, so convert once here.
    const proportion = num(r.est_population_5_17_poverty_pct);
    const kids = num(r.est_population_5_17);
    const poor = num(r.est_population_5_17_poverty);
    const pct = proportion !== null
      ? Math.round(proportion * 1000) / 10
      : kids && poor !== null && kids > 0
        ? Math.round((poor / kids) * 1000) / 10
        : null;
    return {
      leaid: str(r.leaid),
      district_name: str(r.district_name),
      year: num(r.year),
      total_population: num(r.est_population_total),
      school_age_population: kids,
      school_age_in_poverty: poor,
      child_poverty_rate_pct: pct,
    };
  });
  rows.sort((a, b) => (b.child_poverty_rate_pct ?? -1) - (a.child_poverty_rate_pct ?? -1));

  return {
    state: stateArg ?? null,
    leaid: leaid ?? null,
    year,
    count: Math.min(rows.length, limit),
    note: 'Census SAIPE model-based estimates of children aged 5-17 in poverty, by school district. These drive federal Title I allocations. Ranked by poverty rate, highest first. child_poverty_rate_pct is a true PERCENTAGE (4.6 = 4.6%); the upstream field is a proportion and is converted here.',
    districts: rows.slice(0, limit),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'education_find_schools':
      return findSchools(args);
    case 'education_find_districts':
      return findDistricts(args);
    case 'education_district_finance':
      return districtFinance(args);
    case 'education_child_poverty':
      return childPoverty(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
