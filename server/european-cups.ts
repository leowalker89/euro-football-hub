import { EURO_CUP_CONFIG, type EuropeanCupData, type CupTeam, type CupMatch, type CupTie, type CupRound, type CupFavorite, type MatchOdds } from "@shared/schema";

const ESPN_BASE = "https://site.api.espn.com/apis";
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ---- Caching ----
interface CacheEntry<T> { data: T; timestamp: number; }
const cache = new Map<string, CacheEntry<any>>();

function getCached<T>(key: string, maxAgeMs: number): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > maxAgeMs) { cache.delete(key); return null; }
  return entry.data as T;
}
function setCache<T>(key: string, data: T): void { cache.set(key, { data, timestamp: Date.now() }); }

function getCacheTTL(): number {
  const hour = new Date().getUTCHours();
  return (hour >= 10 && hour <= 23) ? 5 * 60 * 1000 : 30 * 60 * 1000;
}

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": "EuroFootballHub/2.0", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`API error: ${res.status} for ${url}`);
  return res.json();
}

// ---- Kalshi Tournament Odds ----
interface KalshiTournamentOdds {
  teamName: string;
  probability: number; // 0-100
  ticker: string;
  isEliminated: boolean; // finalized = eliminated
}

async function fetchTournamentOdds(kalshiTicker: string): Promise<KalshiTournamentOdds[]> {
  const cacheKey = `kalshi:cup:${kalshiTicker}`;
  const cached = getCached<KalshiTournamentOdds[]>(cacheKey, 30 * 60 * 1000);
  if (cached) return cached;

  try {
    const res = await fetch(`${KALSHI_BASE}/markets?limit=40&series_ticker=${kalshiTicker}`, {
      headers: { "Accept": "application/json", "User-Agent": "EuroFootballHub/2.0" },
    });
    if (!res.ok) {
      console.error(`[Kalshi] Cup API error: ${res.status} for ${kalshiTicker}`);
      return [];
    }
    const data = await res.json();
    const markets = data.markets || [];

    const odds: KalshiTournamentOdds[] = markets
      .map((m: any) => ({
        teamName: m.no_sub_title || m.yes_sub_title || "",
        probability: Math.round(parseFloat(m.last_price_dollars || "0") * 100),
        ticker: m.ticker || "",
        isEliminated: m.status === "finalized" || m.status === "settled",
      }))
      .filter((o: KalshiTournamentOdds) => o.teamName);

    console.log(`[Kalshi] ${kalshiTicker}: ${odds.filter(o => !o.isEliminated).length} active teams`);
    setCache(cacheKey, odds);
    return odds;
  } catch (error) {
    console.error(`[Kalshi] Error fetching ${kalshiTicker}:`, error);
    return [];
  }
}

// Team name matching for Kalshi -> ESPN
const CUP_TEAM_NAME_MAP: Record<string, string> = {
  // UCL
  "PSG": "Paris Saint-Germain",
  "Liverpool": "Liverpool",
  "Bayern Munich": "Bayern Munich",
  "Atletico": "Atlético Madrid",
  "Newcastle": "Newcastle United",
  "Tottenham": "Tottenham Hotspur",
  "Sporting Lisbon": "Sporting CP",
  "Galatasaray": "Galatasaray",
  // UEL
  "Nottingham": "Nottingham Forest",
  "Ferencvarosi": "Ferencvaros",
  "Vallecano": "Rayo Vallecano",
  "Czestochowa": "Raków Czestochowa",
  "Larnaca": "AEK Larnaca",
  // UECL
  "Shakhtar": "Shakhtar Donetsk",
  "Strasbourg Alsace": "Strasbourg",
  "Samsunpor": "Samsunspor",
  "Olomouc": "Sigma Olomouc",
};

function matchCupTeam(kalshiName: string, espnName: string): boolean {
  const kLower = kalshiName.toLowerCase();
  const eLower = espnName.toLowerCase();
  if (eLower.includes(kLower) || kLower.includes(eLower)) return true;
  const mapped = CUP_TEAM_NAME_MAP[kalshiName];
  if (mapped) {
    const mLower = mapped.toLowerCase();
    return eLower.includes(mLower) || mLower.includes(eLower);
  }
  return false;
}

function getTeamOdds(teamName: string, odds: KalshiTournamentOdds[]): number | null {
  for (const o of odds) {
    if (matchCupTeam(o.teamName, teamName)) return o.probability;
  }
  return null;
}

function isTeamEliminated(teamName: string, odds: KalshiTournamentOdds[]): boolean {
  for (const o of odds) {
    if (matchCupTeam(o.teamName, teamName)) return o.isEliminated;
  }
  return false;
}

// ---- Parse American odds ----
function americanToImpliedProb(odds: string): number {
  const n = parseInt(odds.replace("EVEN", "100").replace("+", ""));
  if (isNaN(n)) return 0;
  if (n > 0) return 100 / (n + 100);
  return Math.abs(n) / (Math.abs(n) + 100);
}

function determineFavorite(homeML: string | undefined, awayML: string | undefined): string {
  if (!homeML || !awayML) return "unknown";
  const homeProb = americanToImpliedProb(homeML);
  const awayProb = americanToImpliedProb(awayML);
  if (Math.abs(homeProb - awayProb) < 0.05) return "toss-up";
  return homeProb > awayProb ? "home" : "away";
}

function extractOdds(comp: any): MatchOdds | undefined {
  const odds = comp?.odds?.[0];
  if (!odds) return undefined;
  const ml = odds.moneyline || {};
  const homeML = ml.home?.close?.odds;
  const awayML = ml.away?.close?.odds;
  const drawML = ml.draw?.close?.odds;
  if (!homeML && !awayML) return undefined;
  return {
    homeMoneyline: homeML,
    awayMoneyline: awayML,
    drawMoneyline: drawML,
    favorite: determineFavorite(homeML, awayML),
    provider: odds.provider?.name,
  };
}

// ---- ESPN Bracket Data ----

// Fetch all events for a competition across multiple date ranges to get the full knockout phase
async function fetchCupEvents(espnSlug: string): Promise<any[]> {
  const allEvents: any[] = [];
  const seenIds = new Set<string>();

  // Fetch multiple date ranges to capture all knockout rounds
  // Knockout playoff starts in Feb, R16 in Mar, QF in Apr, SF in May, Final in May/Jun
  const dateRanges = [
    "20260201-20260228",
    "20260301-20260331",
    "20260401-20260430",
    "20260501-20260531",
    "20260601-20260615",
  ];

  for (const range of dateRanges) {
    try {
      const data = await fetchJSON(`${ESPN_BASE}/site/v2/sports/soccer/${espnSlug}/scoreboard?dates=${range}`);
      for (const event of data.events || []) {
        if (!seenIds.has(event.id)) {
          seenIds.add(event.id);
          allEvents.push(event);
        }
      }
    } catch (e) {
      // Some date ranges may have no events
    }
  }

  return allEvents;
}

// Group events into ties (two-leg matchups between same teams)
function groupIntoTies(events: any[], kalshiOdds: KalshiTournamentOdds[]): { ties: CupTie[]; roundName: string }[] {
  // Parse all events into matches first
  interface ParsedMatch {
    id: string;
    date: string;
    status: string;
    statusDetail: string;
    homeTeam: CupTeam & { score: number | null };
    awayTeam: CupTeam & { score: number | null };
    leg: string;
    note: string;
    odds?: MatchOdds;
    roundName: string;
  }

  const parsed: ParsedMatch[] = [];

  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const competitors = comp.competitors || [];
    if (competitors.length < 2) continue;

    const notes = comp.notes || [];
    const note = notes[0]?.headline || "";
    const statusName = comp.status?.type?.name || "";
    const statusDetail = comp.status?.type?.shortDetail || comp.status?.type?.detail || "";

    // Determine the leg/round from notes
    let leg = "";
    let roundName = "";
    if (note.includes("1st Leg")) leg = "1st Leg";
    else if (note.includes("2nd Leg")) leg = "2nd Leg";

    // Try to determine round from season info or notes
    const seasonType = event.season?.type?.name || "";
    if (seasonType) roundName = seasonType;

    // Infer round name from date range or competition structure
    // ESPN doesn't always provide clear round names, so we'll categorize by date
    const eventDate = new Date(event.date);
    const month = eventDate.getMonth(); // 0-indexed
    if (!roundName) {
      if (month <= 1) roundName = "Knockout Playoff"; // Feb
      else if (month <= 2) roundName = "Round of 16"; // Mar
      else if (month <= 3) roundName = "Quarter-finals"; // Apr
      else if (month <= 4) roundName = "Semi-finals"; // May
      else roundName = "Final"; // Jun
    }

    const home = competitors.find((c: any) => c.homeAway === "home") || competitors[0];
    const away = competitors.find((c: any) => c.homeAway === "away") || competitors[1];

    parsed.push({
      id: event.id,
      date: event.date,
      status: statusName,
      statusDetail,
      homeTeam: {
        id: home.team.id,
        name: home.team.displayName || home.team.name,
        abbreviation: home.team.abbreviation || home.team.shortDisplayName || "",
        logo: home.team.logo || home.team.logos?.[0]?.href || "",
        score: statusName !== "STATUS_SCHEDULED" ? parseInt(home.score || "0") : null,
      },
      awayTeam: {
        id: away.team.id,
        name: away.team.displayName || away.team.name,
        abbreviation: away.team.abbreviation || away.team.shortDisplayName || "",
        logo: away.team.logo || away.team.logos?.[0]?.href || "",
        score: statusName !== "STATUS_SCHEDULED" ? parseInt(away.score || "0") : null,
      },
      leg,
      note,
      odds: extractOdds(comp),
      roundName,
    });
  }

  // Group matches into ties (pairs of matches between same teams)
  const tieMap = new Map<string, ParsedMatch[]>();

  for (const match of parsed) {
    // Create a key from sorted team IDs to group home/away legs together
    const teamIds = [match.homeTeam.id, match.awayTeam.id].sort();
    const key = `${match.roundName}:${teamIds.join("-")}`;
    if (!tieMap.has(key)) tieMap.set(key, []);
    tieMap.get(key)!.push(match);
  }

  // Organize into rounds
  const roundMap = new Map<string, CupTie[]>();

  for (const [key, matches] of tieMap) {
    const roundName = key.split(":")[0];
    if (!roundMap.has(roundName)) roundMap.set(roundName, []);

    // Sort by date
    matches.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const firstMatch = matches[0];
    // team1 is always the home team in the 1st leg (or only match)
    const team1: CupTeam = {
      id: firstMatch.homeTeam.id,
      name: firstMatch.homeTeam.name,
      abbreviation: firstMatch.homeTeam.abbreviation,
      logo: firstMatch.homeTeam.logo,
    };
    const team2: CupTeam = {
      id: firstMatch.awayTeam.id,
      name: firstMatch.awayTeam.name,
      abbreviation: firstMatch.awayTeam.abbreviation,
      logo: firstMatch.awayTeam.logo,
    };

    // Build match objects
    const cupMatches: CupMatch[] = matches.map((m) => ({
      id: m.id,
      date: m.date,
      status: m.status,
      statusDetail: m.statusDetail,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      leg: m.leg || undefined,
      odds: m.odds,
    }));

    // Calculate aggregate score
    let team1Agg = 0;
    let team2Agg = 0;
    let allComplete = true;
    let anyStarted = false;

    for (const m of matches) {
      if (m.status === "STATUS_SCHEDULED") {
        allComplete = false;
      } else {
        anyStarted = true;
        // Figure out which side team1 and team2 are on in this match
        if (m.homeTeam.id === team1.id) {
          team1Agg += m.homeTeam.score || 0;
          team2Agg += m.awayTeam.score || 0;
        } else {
          team1Agg += m.awayTeam.score || 0;
          team2Agg += m.homeTeam.score || 0;
        }
      }
    }

    // Determine winner from notes or aggregate
    let winner: string | undefined;
    let aggregateNote: string | undefined;

    for (const m of matches) {
      if (m.note.includes("advance") || m.note.includes("win")) {
        aggregateNote = m.note.split(" - ").pop() || m.note;
        // Try to find the advancing team
        if (m.note.includes(team1.name) && m.note.includes("advance")) winner = team1.id;
        else if (m.note.includes(team2.name) && m.note.includes("advance")) winner = team2.id;
        // Also check abbreviations and partial names
        else {
          const noteLower = m.note.toLowerCase();
          if (noteLower.includes(team1.name.toLowerCase().split(" ")[0]) && noteLower.includes("advance")) winner = team1.id;
          else if (noteLower.includes(team2.name.toLowerCase().split(" ")[0]) && noteLower.includes("advance")) winner = team2.id;
        }
      }
    }

    // If no explicit winner from notes but aggregate is decisive and all games done
    const isComplete = allComplete && matches.length >= 2;
    if (!winner && isComplete && team1Agg !== team2Agg) {
      winner = team1Agg > team2Agg ? team1.id : team2.id;
    }

    const aggregateScore = anyStarted ? `${team1Agg}-${team2Agg}` : undefined;

    // Get tournament odds from Kalshi
    const team1Odds = getTeamOdds(team1.name, kalshiOdds);
    const team2Odds = getTeamOdds(team2.name, kalshiOdds);

    const tie: CupTie = {
      team1,
      team2,
      matches: cupMatches,
      aggregateScore,
      aggregateNote,
      winner,
      isComplete: !!winner || isComplete,
      team1TournamentOdds: team1Odds,
      team2TournamentOdds: team2Odds,
    };

    roundMap.get(roundName)!.push(tie);
  }

  // Convert to array and determine current round
  const roundOrder = ["Knockout Playoff", "Round of 16", "Quarter-finals", "Semi-finals", "Final"];
  const result: { ties: CupTie[]; roundName: string }[] = [];

  for (const name of roundOrder) {
    if (roundMap.has(name)) {
      result.push({ roundName: name, ties: roundMap.get(name)! });
    }
  }

  // Also add any round names not in our predefined list
  for (const [name, ties] of roundMap) {
    if (!roundOrder.includes(name)) {
      result.push({ roundName: name, ties });
    }
  }

  return result;
}

// Build the favorites list from Kalshi odds
function buildFavorites(kalshiOdds: KalshiTournamentOdds[], ties: CupTie[]): CupFavorite[] {
  // Build a map of team logos from ties
  const teamLogos = new Map<string, { logo: string; abbr: string; id: string }>();
  for (const tie of ties) {
    teamLogos.set(tie.team1.name.toLowerCase(), { logo: tie.team1.logo, abbr: tie.team1.abbreviation, id: tie.team1.id });
    teamLogos.set(tie.team2.name.toLowerCase(), { logo: tie.team2.logo, abbr: tie.team2.abbreviation, id: tie.team2.id });
  }

  // Find eliminated team names from ties
  const eliminatedTeams = new Map<string, string>(); // eliminated team name -> eliminated by team name
  for (const tie of ties) {
    if (tie.winner) {
      const loser = tie.winner === tie.team1.id ? tie.team2 : tie.team1;
      const winnerTeam = tie.winner === tie.team1.id ? tie.team1 : tie.team2;
      eliminatedTeams.set(loser.name.toLowerCase(), winnerTeam.name);
    }
  }

  return kalshiOdds
    .filter(o => o.probability > 0 || !o.isEliminated) // Show active teams and eliminated with odds > 0
    .map(o => {
      // Try to find team info from ESPN data
      let teamInfo: { logo: string; abbr: string; id: string } | undefined;
      for (const [key, info] of teamLogos) {
        if (matchCupTeam(o.teamName, key)) {
          teamInfo = info;
          break;
        }
      }

      // Find who eliminated them
      let eliminatedBy: string | undefined;
      for (const [key, byName] of eliminatedTeams) {
        if (matchCupTeam(o.teamName, key)) {
          eliminatedBy = byName;
          break;
        }
      }

      return {
        team: {
          id: teamInfo?.id || o.teamName,
          name: o.teamName,
          abbreviation: teamInfo?.abbr || o.teamName.substring(0, 3).toUpperCase(),
          logo: teamInfo?.logo || "",
        },
        tournamentOdds: o.probability,
        isEliminated: o.isEliminated,
        eliminatedBy,
      };
    })
    .sort((a, b) => {
      // Active teams first, then by odds
      if (a.isEliminated && !b.isEliminated) return 1;
      if (!a.isEliminated && b.isEliminated) return -1;
      return b.tournamentOdds - a.tournamentOdds;
    });
}

// ---- Main Export ----

export async function fetchEuropeanCupData(slug: string): Promise<EuropeanCupData> {
  const cacheKey = `eurocup:${slug}`;
  const cached = getCached<EuropeanCupData>(cacheKey, getCacheTTL());
  if (cached) return cached;

  const config = EURO_CUP_CONFIG[slug];
  if (!config) throw new Error(`Unknown European cup: ${slug}`);

  // Fetch ESPN events and Kalshi odds in parallel
  const [events, kalshiOdds] = await Promise.all([
    fetchCupEvents(config.espnSlug),
    fetchTournamentOdds(config.kalshiTicker).catch(() => []),
  ]);

  console.log(`[EuroCup] ${config.shortName}: ${events.length} events, ${kalshiOdds.length} Kalshi markets`);

  // Group into rounds and ties
  const roundsData = groupIntoTies(events, kalshiOdds);

  // Build CupRound objects — filter out placeholder rounds (where teams are "TBD Winner")
  const allTies: CupTie[] = [];
  const rounds: CupRound[] = roundsData
    .filter(r => {
      // Keep rounds where at least one tie has real team names (not placeholder)
      return r.ties.some(t => 
        !t.team1.name.includes("Winner") && !t.team2.name.includes("Winner")
      );
    })
    .map(r => {
      // Filter out placeholder ties within a round
      const realTies = r.ties.filter(t => 
        !t.team1.name.includes("Winner") && !t.team2.name.includes("Winner")
      );
      allTies.push(...realTies);
      const hasActive = realTies.some(t => !t.isComplete);
      return {
        name: r.roundName,
        ties: realTies,
        isCurrent: hasActive,
      };
    });
  // Also add placeholder rounds but with empty ties for bracket visualization
  for (const r of roundsData) {
    const hasPlaceholders = r.ties.some(t => t.team1.name.includes("Winner") || t.team2.name.includes("Winner"));
    const alreadyAdded = rounds.some(existing => existing.name === r.roundName);
    if (hasPlaceholders && !alreadyAdded) {
      rounds.push({
        name: r.roundName,
        ties: [], // Empty — future round
        isCurrent: false,
      });
    }
  }

  // If no round is current (all complete), mark the last one
  if (rounds.length > 0 && !rounds.some(r => r.isCurrent)) {
    rounds[rounds.length - 1].isCurrent = true;
  }

  // Determine current round name
  const currentRound = rounds.find(r => r.isCurrent)?.name || "TBD";

  // Build favorites
  const favorites = buildFavorites(kalshiOdds, allTies);

  const result: EuropeanCupData = {
    slug,
    name: config.name,
    shortName: config.shortName,
    currentRound,
    rounds,
    favorites,
    oddsSource: kalshiOdds.length > 0 ? "kalshi" : "none",
    lastUpdated: new Date().toISOString(),
  };

  setCache(cacheKey, result);
  return result;
}

export async function fetchAllEuropeanCups(): Promise<EuropeanCupData[]> {
  const slugs = Object.keys(EURO_CUP_CONFIG);
  return Promise.all(slugs.map(slug => fetchEuropeanCupData(slug)));
}
