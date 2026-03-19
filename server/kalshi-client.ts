/**
 * Centralized Kalshi API client with rate limiting and retry logic.
 * All Kalshi API calls across the app should go through this module
 * to avoid concurrent request rate-limiting (429 errors).
 */

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// Global request queue to serialize Kalshi API calls
let requestQueue: Promise<any> = Promise.resolve();
const MIN_DELAY_MS = 300; // minimum delay between requests

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const queued = requestQueue.then(async () => {
    await new Promise(r => setTimeout(r, MIN_DELAY_MS));
    return fn();
  });
  // Update queue head (don't let rejections break the chain)
  requestQueue = queued.catch(() => {});
  return queued;
}

/**
 * Fetch markets from Kalshi with retry and rate-limiting.
 * Returns raw market objects from the API.
 */
export async function fetchKalshiMarkets(
  seriesTicker: string,
  retries = 2
): Promise<any[]> {
  return enqueue(async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(
          `${KALSHI_BASE}/markets?limit=40&series_ticker=${seriesTicker}`,
          {
            headers: {
              "Accept": "application/json",
              "User-Agent": "EuroFootballHub/2.0",
            },
          }
        );
        if (!res.ok) {
          console.error(`[Kalshi] API error: ${res.status} for ${seriesTicker} (attempt ${attempt + 1})`);
          if (res.status === 429 && attempt < retries) {
            // Rate limited — back off more aggressively
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          return [];
        }
        const data = await res.json();
        return data.markets || [];
      } catch (error) {
        console.error(`[Kalshi] Error fetching ${seriesTicker} (attempt ${attempt + 1}):`, error);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        return [];
      }
    }
    return [];
  });
}
