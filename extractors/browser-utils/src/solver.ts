import type { BrowserContext } from "playwright";
import { isChallengePage } from "./challenge.js";
import { readCookieJar, saveCookies } from "./cookies.js";
import { createLaunchOptions } from "./launch.js";

export type SolverResult =
  | { status: "solved"; cookiesSaved: number }
  | { status: "timeout" }
  | { status: "error"; message: string };

// Cloudflare frequently commits the cf_clearance cookie a beat *after* the
// interstitial markup clears, so saving the instant the challenge visually
// disappears can race ahead of the cookie being written. Give it a short
// window to appear before declaring the solve unusable.
const CLEARANCE_SETTLE_TIMEOUT_MS = 10_000;
const CLEARANCE_POLL_INTERVAL_MS = 500;

function noReusableCookiesError(detail?: string): SolverResult {
  const base =
    "Challenge appeared solved, but no reusable Cloudflare clearance cookie was saved.";
  return {
    status: "error",
    message: detail ? `${base} (${detail})` : base,
  };
}

async function hasClearanceCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies();
  return cookies.some((cookie) => cookie.name === "cf_clearance");
}

/** Poll the context for a cf_clearance cookie until it appears or time runs out. */
async function waitForClearanceCookie(
  context: BrowserContext,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (true) {
    if (await hasClearanceCookie(context)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, CLEARANCE_POLL_INTERVAL_MS),
    );
  }
}

/** Human-readable summary of what cookies were present, for diagnosing a failed solve. */
async function summarizeCookies(context: BrowserContext): Promise<string> {
  try {
    const cookies = await context.cookies();
    if (cookies.length === 0) return "no cookies were set";
    const names = Array.from(new Set(cookies.map((cookie) => cookie.name)));
    const preview = names.slice(0, 12).join(", ");
    const suffix = names.length > 12 ? ", …" : "";
    return `cookies present: ${preview}${suffix}; none was a valid cf_clearance`;
  } catch {
    return "cookie inventory unavailable";
  }
}

type ReusableCookieOutcome =
  | { ok: true; cookiesSaved: number }
  | { ok: false; detail: string };

async function saveReusableCookies(
  context: BrowserContext,
  extractorId: string,
  storageDir: string,
): Promise<ReusableCookieOutcome> {
  await waitForClearanceCookie(context, CLEARANCE_SETTLE_TIMEOUT_MS);

  const cookiesSaved = await saveCookies(context, extractorId, storageDir);
  if (cookiesSaved > 0) {
    const jar = await readCookieJar(extractorId, storageDir);
    if (jar.hasClearanceCookie) return { ok: true, cookiesSaved };
  }

  return { ok: false, detail: await summarizeCookies(context) };
}

const SOLVED_PAGE = `data:text/html,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0a0a; color:#4ade80; font-family:system-ui,sans-serif; text-align:center; }
  h1 { font-size:2rem; font-weight:600; margin-bottom:0.5rem; }
  p { color:#a1a1aa; font-size:1.1rem; }
</style></head><body>
  <div><h1>Challenge solved</h1><p>You can close this tab and return to Job Ops.</p></div>
</body></html>`)}`;

/**
 * Opens a headed browser for a human to solve a Cloudflare challenge.
 *
 * This is the "2FA for scraping" flow: the system can't solve the challenge
 * headless, so it opens a visible browser, lets the human interact, detects
 * when the challenge is resolved, saves the cookies, and closes.
 *
 * The saved cookies (especially cf_clearance) allow subsequent headless runs
 * to skip the challenge until the cookie expires.
 *
 * @param url - The URL that triggered the challenge
 * @param extractorId - Used to namespace the saved cookies
 * @param storageDir - Where to save cookies (e.g. "./storage")
 * @param timeoutMs - Max time to wait for the human (default 5 minutes)
 */
export async function solveChallenge(
  url: string,
  extractorId: string,
  storageDir: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<SolverResult> {
  let context: BrowserContext | undefined;
  let browser:
    | Awaited<ReturnType<typeof import("playwright").firefox.launch>>
    | undefined;

  try {
    const { firefox } = await import("playwright");
    // Always headed — the whole point is a human needs to see the challenge
    // and click through it. The solved cf_clearance cookie is tied to this
    // browser's UA + TLS fingerprint, so extractors must reuse the same UA
    // (persisted in the cookie jar) when creating their headless context.
    const { launchOptions } = await createLaunchOptions({ headless: false });
    browser = await firefox.launch(launchOptions);
    context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // If there's no challenge, we're done — save cookies anyway since the
    // browser session established a valid cf_clearance
    if (!(await isChallengePage(page))) {
      const outcome = await saveReusableCookies(
        context,
        extractorId,
        storageDir,
      );
      if (!outcome.ok) return noReusableCookiesError(outcome.detail);
      await showSolvedPage(page);
      return { status: "solved", cookiesSaved: outcome.cookiesSaved };
    }

    // Poll until the challenge is resolved or timeout
    const start = Date.now();
    const pollInterval = 2_000;

    while (Date.now() - start < timeoutMs) {
      await page.waitForTimeout(pollInterval);

      if (!(await isChallengePage(page))) {
        const outcome = await saveReusableCookies(
          context,
          extractorId,
          storageDir,
        );
        if (!outcome.ok) return noReusableCookiesError(outcome.detail);
        await showSolvedPage(page);
        return { status: "solved", cookiesSaved: outcome.cookiesSaved };
      }
    }

    return { status: "timeout" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser?.close();
  }
}

/** Show a "challenge solved" page so the VNC user knows they can close the tab. */
async function showSolvedPage(page: {
  goto: (url: string, opts?: { timeout?: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
}): Promise<void> {
  try {
    await page.goto(SOLVED_PAGE, { timeout: 5_000 });
    // Brief pause so the user sees the message before the browser closes
    await page.waitForTimeout(3_000);
  } catch {
    // Non-critical - the solve already succeeded
  }
}
