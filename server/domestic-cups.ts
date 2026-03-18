import { DOMESTIC_CUP_CONFIG, type DomesticCupData, type DomesticCupMatch } from "@shared/schema";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// Simple cache
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}
const cache = new Map<string, CacheEntry<any>>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// Fetch events from ESPN scoreboard for a domestic cup
async function fetchCupEvents(espnSlug: string): Promise<any[]> {
  try {
    // Fetch recent + upcoming matches (last 2 months through end of season)
    const now = new Date();
    const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const startDate = twoMonthsAgo.toISOString().slice(0, 10).replace(/-/g, "");
    const res = await fetch(
      `${ESPN_BASE}/${espnSlug}/scoreboard?dates=${startDate}-20260701&limit=100`,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "EuroFootballHub/2.0",
        },
      }
    );
    if (!res.ok) {
      console.error(`[DomesticCup] ESPN error ${res.status} for ${espnSlug}`);
      return [];
    }
    const data = await res.json();
    return data.events || [];
  } catch (error) {
    console.error(`[DomesticCup] Error fetching ${espnSlug}:`, error);
    return [];
  }
}

// Parse ESPN event into a DomesticCupMatch
function parseEvent(event: any): DomesticCupMatch | null {
  const comp = event.competitions?.[0];
  if (!comp || !comp.competitors || comp.competitors.length < 2) return null;

  const homeComp = comp.competitors.find((c: any) => c.homeAway === "home") || comp.competitors[0];
  const awayComp = comp.competitors.find((c: any) => c.homeAway === "away") || comp.competitors[1];

  const statusType = event.status?.type?.name || "STATUS_SCHEDULED";
  const statusText = event.status?.type?.description || "Scheduled";

  // Parse penalty scores from the linescores if available
  const parsePenaltyScore = (competitor: any): number | null => {
    const linescores = competitor.linescores;
    if (!linescores || !Array.isArray(linescores)) return null;
    // Penalty shootout is typically the last linescore period beyond normal + extra time
    if (linescores.length >= 4) {
      // 4th entry could be penalties
      return linescores[3]?.value ?? null;
    }
    return null;
  };

  const notes = comp.notes || [];
  const noteText = notes[0]?.headline || "";

  return {
    id: event.id || "",
    date: event.date || "",
    status: statusType,
    statusText,
    homeTeam: {
      id: homeComp.team?.id || "",
      name: homeComp.team?.shortDisplayName || homeComp.team?.displayName || "",
      abbreviation: homeComp.team?.abbreviation || "",
      logo: homeComp.team?.logo || "",
      score: statusType !== "STATUS_SCHEDULED" ? parseInt(homeComp.score || "0") : null,
      winner: homeComp.winner || false,
      penaltyScore: parsePenaltyScore(homeComp),
    },
    awayTeam: {
      id: awayComp.team?.id || "",
      name: awayComp.team?.shortDisplayName || awayComp.team?.displayName || "",
      abbreviation: awayComp.team?.abbreviation || "",
      logo: awayComp.team?.logo || "",
      score: statusType !== "STATUS_SCHEDULED" ? parseInt(awayComp.score || "0") : null,
      winner: awayComp.winner || false,
      penaltyScore: parsePenaltyScore(awayComp),
    },
    note: noteText || undefined,
  };
}

// Determine the current round name based on number of matches
function inferRound(totalMatches: number, upcomingCount: number, completedCount: number): string {
  // For upcoming matches, use the count to determine round
  const relevantCount = upcomingCount > 0 ? upcomingCount : completedCount;
  if (relevantCount <= 1) return "Final";
  if (relevantCount <= 2) return "Semi-Finals";
  if (relevantCount <= 4) return "Quarter-Finals";
  if (relevantCount <= 8) return "Round of 16";
  if (relevantCount <= 16) return "Round of 32";
  return "Early Rounds";
}

export async function fetchDomesticCupData(slug: string): Promise<DomesticCupData> {
  const cacheKey = `domestic-cup:${slug}`;
  const cached = getCached<DomesticCupData>(cacheKey);
  if (cached) return cached;

  const config = DOMESTIC_CUP_CONFIG[slug];
  if (!config) throw new Error(`Unknown domestic cup: ${slug}`);

  const events = await fetchCupEvents(config.espnSlug);
  console.log(`[DomesticCup] ${config.shortName}: ${events.length} events`);

  const allMatches = events
    .map(parseEvent)
    .filter((m): m is DomesticCupMatch => m !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()); // newest first

  // Split into completed and upcoming
  const completed = allMatches.filter(m =>
    m.status !== "STATUS_SCHEDULED" && m.status !== "STATUS_POSTPONED"
  );
  const upcoming = allMatches
    .filter(m => m.status === "STATUS_SCHEDULED")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()); // soonest first

  // Get the most recent completed matches (latest round)
  // Group by approximate date clusters (matches within 7 days = same round)
  const recentResults: DomesticCupMatch[] = [];
  if (completed.length > 0) {
    const latestDate = new Date(completed[0].date).getTime();
    for (const m of completed) {
      const daysDiff = (latestDate - new Date(m.date).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff <= 10) {
        recentResults.push(m);
      }
    }
  }

  // Determine current round
  let currentRound: string;
  if (upcoming.length > 0) {
    currentRound = inferRound(allMatches.length, upcoming.length, recentResults.length);
  } else if (recentResults.length > 0) {
    // If all done and only 1 result, that was the Final
    currentRound = inferRound(allMatches.length, 0, recentResults.length);
  } else {
    currentRound = "TBD";
  }

  // If we have a final scheduled, override
  if (upcoming.length === 1) currentRound = "Final";
  if (upcoming.length === 2) currentRound = "Semi-Finals";
  if (upcoming.length <= 4 && upcoming.length > 2) currentRound = "Quarter-Finals";

  const result: DomesticCupData = {
    slug,
    name: config.name,
    shortName: config.shortName,
    country: config.country,
    countryFlag: config.countryFlag,
    logo: config.logo,
    currentRound,
    recentResults: recentResults.slice(0, 8), // Limit to 8 most recent
    upcomingMatches: upcoming.slice(0, 8), // Limit to 8 upcoming
    lastUpdated: new Date().toISOString(),
  };

  setCache(cacheKey, result);
  return result;
}

export async function fetchAllDomesticCups(): Promise<DomesticCupData[]> {
  const slugs = Object.keys(DOMESTIC_CUP_CONFIG);
  return Promise.all(slugs.map(slug => fetchDomesticCupData(slug)));
}
