import type { LeagueSlug } from "@shared/schema";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// Cache for Kalshi data (refresh every 30 minutes)
interface KalshiCache<T> {
  data: T;
  timestamp: number;
}

const kalshiCache = new Map<string, KalshiCache<any>>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCached<T>(key: string): T | null {
  const entry = kalshiCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    kalshiCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  kalshiCache.set(key, { data, timestamp: Date.now() });
}

// Kalshi series tickers mapped to our league slugs
const TITLE_SERIES: Record<string, string> = {
  "eng.1": "KXPREMIERLEAGUE",
  "ger.1": "KXBUNDESLIGA",
  "ita.1": "KXSERIEA",
  "esp.1": "KXLALIGA",
  "fra.1": "KXLIGUE1",
};

const RELEGATION_SERIES: Record<string, string> = {
  "eng.1": "KXEPLRELEGATION",
  "ger.1": "KXBUNDESLIGARELEGATION",
  "ita.1": "KXSERIEARELEGATION",
  "esp.1": "KXLALIGARELEGATION",
  "fra.1": "KXLIGUE1RELEGATION",
};

// Team name normalization: Kalshi uses short names, ESPN uses full names
// We do fuzzy matching but some need explicit mapping
const TEAM_NAME_MAP: Record<string, string> = {
  // EPL
  "Man City": "Manchester City",
  "Man Utd": "Manchester United",
  "Wolves": "Wolverhampton Wanderers",
  "Sunderland": "Sunderland",
  "Leeds": "Leeds United",
  "Tottenham": "Tottenham Hotspur",
  "Nottingham Forest": "Nottingham Forest",
  "West Ham": "West Ham United",
  "Burnley": "Burnley",
  "Newcastle": "Newcastle United",
  "Crystal Palace": "Crystal Palace",
  "Bournemouth": "AFC Bournemouth",
  "Brighton": "Brighton & Hove Albion",
  "Aston Villa": "Aston Villa",
  // Bundesliga
  "M´gladbach": "Borussia Mönchengladbach",
  "Bayern Munich": "Bayern Munich",
  "Leverkusen": "Bayer Leverkusen",
  "Leipzig": "RB Leipzig",
  "Bremen": "Werder Bremen",
  "Frankfurt": "Eintracht Frankfurt",
  // FC Cologne: matches directly via fuzzy match
  "Dortmund": "Borussia Dortmund",
  "Hamburg": "Hamburger SV",
  "Mainz": "1. FSV Mainz 05",
  "Augsburg": "FC Augsburg",
  "Wolfsburg": "VfL Wolfsburg",
  "Stuttgart": "VfB Stuttgart",
  "Hoffenheim": "TSG Hoffenheim",
  "Union Berlin": "1. FC Union Berlin",
  "Heidenheim": "1. FC Heidenheim",
  "Freiburg": "SC Freiburg",
  "St. Pauli": "FC St. Pauli",
  // Serie A
  "Inter": "Internazionale",
  "Milan": "AC Milan",
  "Hellas Verona": "Verona",
  "Parma Calcio": "Parma",
  "Pisa": "Pisa",
  "Cremonese": "Cremonese",
  // La Liga
  "Betis": "Real Betis",
  "Atletico Madrid": "Atlético Madrid",
  "Oviedo": "Real Oviedo",
  "Levante": "Levante",
  "Alaves": "Deportivo Alavés",
  "Elche": "Elche",
  // Ligue 1
  "PSG": "Paris Saint-Germain",
  "Paris": "Paris FC",
  "Stade Brest 29": "Brest",
  "Stade Rennes": "Rennes",
  "Strasbourg Alsace": "Strasbourg",
  "Metz": "FC Metz",
  "Auxerre": "AJ Auxerre",
  "Lorient": "FC Lorient",
  "Le Havre": "Le Havre",
  "Angers": "Angers SCO",
};

export interface KalshiOdds {
  teamName: string;       // Kalshi team name
  probability: number;    // 0-100 (derived from last_price_dollars * 100)
  ticker: string;         // Market ticker for reference
}

export interface LeagueOdds {
  title: KalshiOdds[];
  relegation: KalshiOdds[];
  lastUpdated: string;
}

async function fetchKalshiMarkets(seriesTicker: string): Promise<any[]> {
  try {
    const res = await fetch(
      `${KALSHI_BASE}/markets?limit=30&status=open&series_ticker=${seriesTicker}`,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "EuroFootballHub/2.0",
        },
      }
    );
    if (!res.ok) {
      console.error(`Kalshi API error: ${res.status} for ${seriesTicker}`);
      return [];
    }
    const data = await res.json();
    return data.markets || [];
  } catch (error) {
    console.error(`Error fetching Kalshi markets for ${seriesTicker}:`, error);
    return [];
  }
}

function parseMarkets(markets: any[]): KalshiOdds[] {
  return markets
    .map((m: any) => {
      const price = parseFloat(m.last_price_dollars || "0");
      const teamName = m.no_sub_title || m.yes_sub_title || "";
      return {
        teamName,
        probability: Math.round(price * 100),
        ticker: m.ticker || "",
      };
    })
    .filter((o: KalshiOdds) => o.teamName && o.probability >= 0)
    .sort((a: KalshiOdds, b: KalshiOdds) => b.probability - a.probability);
}

export async function fetchLeagueOdds(slug: LeagueSlug): Promise<LeagueOdds> {
  const cacheKey = `kalshi:${slug}`;
  const cached = getCached<LeagueOdds>(cacheKey);
  if (cached) return cached;

  const titleSeries = TITLE_SERIES[slug];
  const relSeries = RELEGATION_SERIES[slug];

  const [titleMarkets, relMarkets] = await Promise.all([
    titleSeries ? fetchKalshiMarkets(titleSeries) : Promise.resolve([]),
    relSeries ? fetchKalshiMarkets(relSeries) : Promise.resolve([]),
  ]);

  const odds: LeagueOdds = {
    title: parseMarkets(titleMarkets),
    relegation: parseMarkets(relMarkets),
    lastUpdated: new Date().toISOString(),
  };

  setCache(cacheKey, odds);
  return odds;
}

// Match a Kalshi team name to an ESPN team name using fuzzy matching
export function matchKalshiTeam(kalshiName: string, espnName: string): boolean {
  const kLower = kalshiName.toLowerCase();
  const eLower = espnName.toLowerCase();

  // Direct fuzzy match first (handles exact and substring matches)
  if (eLower.includes(kLower) || kLower.includes(eLower)) return true;

  // Check explicit mapping
  const mapped = TEAM_NAME_MAP[kalshiName];
  if (mapped) {
    const mLower = mapped.toLowerCase();
    return eLower.includes(mLower) || mLower.includes(eLower);
  }

  return false;
}

// Get title odds for a specific team (returns probability 0-100 or null)
export function getTitleOddsForTeam(
  teamName: string,
  odds: LeagueOdds
): number | null {
  for (const entry of odds.title) {
    if (matchKalshiTeam(entry.teamName, teamName)) {
      return entry.probability;
    }
  }
  return null;
}

// Get relegation odds for a specific team (returns probability 0-100 or null)
export function getRelegationOddsForTeam(
  teamName: string,
  odds: LeagueOdds
): number | null {
  for (const entry of odds.relegation) {
    if (matchKalshiTeam(entry.teamName, teamName)) {
      return entry.probability;
    }
  }
  return null;
}

// Fetch odds for all leagues in parallel
export async function fetchAllLeagueOdds(): Promise<Record<string, LeagueOdds>> {
  const slugs = Object.keys(TITLE_SERIES) as LeagueSlug[];
  const results = await Promise.all(
    slugs.map(async (slug) => {
      const odds = await fetchLeagueOdds(slug);
      return [slug, odds] as const;
    })
  );
  return Object.fromEntries(results);
}
