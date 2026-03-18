import { LEAGUES, COMPETITIONS, LEAGUE_CUPS, EURO_COMPS, type LeagueSlug, type StandingEntry, type Match, type Article, type LeagueData, type BattleGroup, type MatchOdds } from "@shared/schema";
import { fetchLeagueOdds, getTitleOddsForTeam, getRelegationOddsForTeam, type LeagueOdds } from "./kalshi";

const ESPN_BASE = "https://site.api.espn.com/apis";

// In-memory cache
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<any>>();

function getCached<T>(key: string, maxAgeMs: number): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > maxAgeMs) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

function getCacheTTL(): number {
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour >= 10 && hour <= 23) {
    return 5 * 60 * 1000; // 5 minutes during match hours
  }
  return 30 * 60 * 1000; // 30 minutes off-peak
}

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "EuroFootballHub/2.0",
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`ESPN API error: ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

// Parse American odds to implied probability
function americanToImpliedProb(odds: string): number {
  const n = parseInt(odds.replace("EVEN", "100").replace("+", ""));
  if (isNaN(n)) return 0;
  if (n > 0) return 100 / (n + 100);
  return Math.abs(n) / (Math.abs(n) + 100);
}

// Determine favorite from moneyline odds
function determineFavorite(homeML: string | undefined, awayML: string | undefined): string {
  if (!homeML || !awayML) return "unknown";
  const homeProb = americanToImpliedProb(homeML);
  const awayProb = americanToImpliedProb(awayML);
  if (Math.abs(homeProb - awayProb) < 0.05) return "toss-up";
  return homeProb > awayProb ? "home" : "away";
}

// Extract odds from ESPN event data
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
    homeSpread: odds.pointSpread?.home?.close?.line,
    awaySpread: odds.pointSpread?.away?.close?.line,
    overUnder: odds.overUnder || undefined,
    favorite: determineFavorite(homeML, awayML),
    provider: odds.provider?.displayName || "DraftKings",
    details: odds.details || undefined,
  };
}

// Check if a completed match was an upset based on pre-match odds
function detectUpset(match: Match): { isUpset: boolean; upsetDetails?: string } {
  if (!match.odds || match.homeTeam.score === null || match.awayTeam.score === null) {
    return { isUpset: false };
  }

  const fav = match.odds.favorite;
  if (!fav || fav === "toss-up" || fav === "unknown") return { isUpset: false };

  const homeScore = match.homeTeam.score;
  const awayScore = match.awayTeam.score;

  if (fav === "home" && awayScore > homeScore) {
    return {
      isUpset: true,
      upsetDetails: `${match.awayTeam.name} upset ${match.homeTeam.name} away from home`,
    };
  }
  if (fav === "away" && homeScore > awayScore) {
    return {
      isUpset: true,
      upsetDetails: `${match.homeTeam.name} upset favored ${match.awayTeam.name}`,
    };
  }
  // Draw when there's a clear favorite is a mild upset
  if (homeScore === awayScore && fav !== "toss-up") {
    const favName = fav === "home" ? match.homeTeam.name : match.awayTeam.name;
    const favOdds = fav === "home" ? match.odds.homeMoneyline : match.odds.awayMoneyline;
    // Only flag as upset if favorite had strong odds (negative moneyline)
    if (favOdds && parseInt(favOdds) < -120) {
      return {
        isUpset: true,
        upsetDetails: `${favName} (${favOdds}) held to a draw`,
      };
    }
  }

  return { isUpset: false };
}

// Fetch team form data (WDLWW) from recent scoreboard dates
async function fetchTeamForms(slug: LeagueSlug): Promise<Map<string, string>> {
  const cacheKey = `forms:${slug}`;
  const cached = getCached<Map<string, string>>(cacheKey, getCacheTTL());
  if (cached) return cached;

  const formMap = new Map<string, string>();
  // Check today + past few days to find form for as many teams as possible
  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  // Also check upcoming
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }

  try {
    // Fetch a few dates in parallel to get more team forms
    const results = await Promise.allSettled(
      dates.map(date => fetchJSON(`${ESPN_BASE}/site/v2/sports/soccer/${slug}/scoreboard?dates=${date}`))
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        const events = result.value?.events || [];
        for (const event of events) {
          const comps = event.competitions?.[0]?.competitors || [];
          for (const c of comps) {
            if (c.form && c.team?.id && !formMap.has(c.team.id)) {
              formMap.set(c.team.id, c.form);
            }
          }
        }
      }
    }
  } catch {
    // Form data is supplementary, don't fail if unavailable
  }
  setCache(cacheKey, formMap);
  return formMap;
}

export async function fetchStandings(slug: LeagueSlug): Promise<StandingEntry[]> {
  const cacheKey = `standings:${slug}`;
  const cached = getCached<StandingEntry[]>(cacheKey, getCacheTTL());
  if (cached) return cached;

  try {
    const [data, formMap] = await Promise.all([
      fetchJSON(`${ESPN_BASE}/v2/sports/soccer/${slug}/standings`),
      fetchTeamForms(slug),
    ]);
    const entries = data?.children?.[0]?.standings?.entries || [];
    const totalGames = LEAGUES[slug].totalGames;

    const standings: StandingEntry[] = entries.map((entry: any) => {
      const stats = entry.stats || [];
      const getStat = (name: string): number => {
        const stat = stats.find((s: any) => s.name === name);
        return stat ? Number(stat.value) || 0 : 0;
      };

      const gp = getStat("gamesPlayed");
      const pts = getStat("points");
      const remaining = totalGames - gp;
      const teamId = entry.team?.id || "";

      return {
        rank: getStat("rank"),
        teamId,
        teamName: entry.team?.displayName || entry.team?.name || "",
        teamAbbreviation: entry.team?.abbreviation || "",
        teamLogo: entry.team?.logos?.[0]?.href || "",
        gamesPlayed: gp,
        wins: getStat("wins"),
        draws: getStat("ties"),
        losses: getStat("losses"),
        goalsFor: getStat("pointsFor"),
        goalsAgainst: getStat("pointsAgainst"),
        goalDifference: getStat("pointDifferential"),
        points: pts,
        form: stats.find((s: any) => s.name === "overall")?.displayValue || "",
        recentForm: formMap.get(teamId) || undefined,
        zone: entry.note?.description || undefined,
        zoneColor: entry.note?.color || undefined,
        gamesRemaining: remaining,
        ppg: gp > 0 ? Math.round((pts / gp) * 100) / 100 : 0,
        maxPossiblePoints: pts + (remaining * 3),
      };
    });

    standings.sort((a, b) => a.rank - b.rank);
    setCache(cacheKey, standings);
    return standings;
  } catch (error) {
    console.error(`Error fetching standings for ${slug}:`, error);
    return [];
  }
}

// Fetch matches for a date range, with form and odds
async function fetchMatchesForDates(slug: LeagueSlug, dates: string[]): Promise<Match[]> {
  const allMatches: Match[] = [];
  // Also build a rank lookup from standings
  const standings = await fetchStandings(slug);
  const rankMap = new Map<string, number>();
  standings.forEach(s => rankMap.set(s.teamId, s.rank));

  for (const date of dates) {
    try {
      const data = await fetchJSON(`${ESPN_BASE}/site/v2/sports/soccer/${slug}/scoreboard?dates=${date}`);
      const events = data?.events || [];

      for (const event of events) {
        const comp = event.competitions?.[0];
        const competitors = comp?.competitors || [];
        const home = competitors.find((c: any) => c.homeAway === "home") || competitors[0];
        const away = competitors.find((c: any) => c.homeAway === "away") || competitors[1];
        const status = comp?.status?.type;
        const odds = extractOdds(comp);

        const match: Match = {
          id: event.id || "",
          date: event.date || "",
          status: status?.description || "Scheduled",
          statusDetail: status?.detail || undefined,
          homeTeam: {
            id: home?.team?.id || "",
            name: home?.team?.displayName || home?.team?.name || "",
            abbreviation: home?.team?.abbreviation || "",
            logo: home?.team?.logo || "",
            score: home?.score != null ? Number(home.score) : null,
            form: home?.form || undefined,
            rank: rankMap.get(home?.team?.id) || undefined,
          },
          awayTeam: {
            id: away?.team?.id || "",
            name: away?.team?.displayName || away?.team?.name || "",
            abbreviation: away?.team?.abbreviation || "",
            logo: away?.team?.logo || "",
            score: away?.score != null ? Number(away.score) : null,
            form: away?.form || undefined,
            rank: rankMap.get(away?.team?.id) || undefined,
          },
          odds,
        };

        // Detect upsets for completed matches
        if (status?.completed && odds) {
          const upset = detectUpset(match);
          match.isUpset = upset.isUpset;
          match.upsetDetails = upset.upsetDetails;
        }

        allMatches.push(match);
      }
    } catch (error) {
      // Skip date if fetch fails
      console.error(`Error fetching matches for ${slug} on ${date}:`, error);
    }
  }

  return allMatches;
}

export async function fetchRecentMatches(slug: LeagueSlug): Promise<Match[]> {
  const cacheKey = `recent:${slug}`;
  const cached = getCached<Match[]>(cacheKey, getCacheTTL());
  if (cached) return cached;

  // Fetch last 14 days to get recent completed matches
  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }

  const matches = await fetchMatchesForDates(slug, dates);
  // Filter to completed only, sort newest first
  const completed = matches
    .filter(m => m.status.toLowerCase().includes("full") || m.status.toLowerCase().includes("final"))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  setCache(cacheKey, completed);
  return completed;
}

export async function fetchUpcomingMatches(slug: LeagueSlug): Promise<Match[]> {
  const cacheKey = `upcoming:${slug}`;
  const cached = getCached<Match[]>(cacheKey, getCacheTTL());
  if (cached) return cached;

  // Fetch next 14 days
  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }

  const matches = await fetchMatchesForDates(slug, dates);
  // Filter to scheduled/upcoming only
  const upcoming = matches
    .filter(m => {
      const st = m.status.toLowerCase();
      return st.includes("scheduled") || st.includes("pre") || st.includes("postponed");
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  setCache(cacheKey, upcoming);
  return upcoming;
}

// Hardcoded fallback odds in case Kalshi API is unavailable
const FALLBACK_TITLE_ODDS: Record<string, Record<string, number>> = {
  "eng.1": { "Arsenal": 88, "Manchester City": 8 },
  "ger.1": { "Bayern Munich": 99 },
  "ita.1": { "Internazionale": 90, "AC Milan": 7, "Napoli": 4 },
  "esp.1": { "Barcelona": 78, "Real Madrid": 19 },
  "fra.1": { "Paris Saint-Germain": 91, "Lens": 7 },
};

function getFallbackTitleOdds(teamName: string, slug: LeagueSlug): number | null {
  const leagueOdds = FALLBACK_TITLE_ODDS[slug];
  if (!leagueOdds) return null;
  for (const [name, odds] of Object.entries(leagueOdds)) {
    if (teamName.includes(name) || name.includes(teamName)) return odds;
  }
  return null;
}

// Smart battle grouping
export function computeBattles(standings: StandingEntry[], slug: LeagueSlug, kalshiOdds?: LeagueOdds): BattleGroup[] {
  if (standings.length === 0) return [];

  const config = LEAGUES[slug];
  const leader = standings[0];
  const totalGames = config.totalGames;
  const battles: BattleGroup[] = [];

  // --- IDENTIFY TITLE CONTENDERS (used to flag within European Places) ---
  const titleContenderIds = new Set<string>();
  for (const team of standings) {
    if (team.rank === 1) {
      titleContenderIds.add(team.teamId);
      continue;
    }
    const gap = leader.points - team.points;
    const remaining = team.gamesRemaining || (totalGames - team.gamesPlayed);
    const canCatch = (team.maxPossiblePoints || 0) >= leader.points;
    const plausible = gap <= Math.ceil(remaining * 1.5);
    const realistic = !(gap > 15 && remaining <= 10);
    // Use Kalshi odds if available, fall back to hardcoded
    const odds = kalshiOdds
      ? getTitleOddsForTeam(team.teamName, kalshiOdds)
      : getFallbackTitleOdds(team.teamName, slug);
    // If a team has <5% implied odds, skip them
    // If no odds data exists and gap is large (>10), also skip (avoids false positives)
    const hasRealisticOdds = odds !== null ? odds >= 5 : gap <= 10;
    if (canCatch && plausible && realistic && hasRealisticOdds && team.rank <= 8) {
      titleContenderIds.add(team.teamId);
    }
  }

  // Backfill: if a lower-ranked team is a title contender, all higher-ranked
  // teams between them and the leader must also be contenders (can't skip over
  // a team with more points). E.g. if 4th place is flagged, 2nd and 3rd must be too.
  if (titleContenderIds.size > 1) {
    let lowestContenderRank = 1;
    for (const team of standings) {
      if (titleContenderIds.has(team.teamId) && team.rank > lowestContenderRank) {
        lowestContenderRank = team.rank;
      }
    }
    for (const team of standings) {
      if (team.rank <= lowestContenderRank) {
        titleContenderIds.add(team.teamId);
      }
    }
  }

  // --- EUROPEAN PLACES (with title contenders merged in) ---
  const totalEuroSpots = config.uclSpots + config.europaSpots + config.confSpots;
  const lastEuroTeam = standings[totalEuroSpots - 1];
  const firstNonEuro = standings[totalEuroSpots];

  // Collect all teams that belong in this section:
  // 1. Teams in European zone positions
  // 2. Teams within striking distance (8pts of last euro spot)
  // 3. Title contenders (always included since they're top teams)
  const euroTeamIds = new Set<string>();
  const euroTeams: StandingEntry[] = [];

  for (const team of standings) {
    const hasEuroZone = team.zone?.toLowerCase().includes("champions") ||
      team.zone?.toLowerCase().includes("europa") ||
      team.zone?.toLowerCase().includes("conference");
    const isInRange = lastEuroTeam && Math.abs(team.points - lastEuroTeam.points) <= 8 && team.rank <= totalEuroSpots + 4;
    const isTitleTeam = titleContenderIds.has(team.teamId);

    if (hasEuroZone || isInRange || isTitleTeam) {
      if (!euroTeamIds.has(team.teamId)) {
        euroTeamIds.add(team.teamId);
        // Mark title contenders on the team object
        const titleOddsVal = kalshiOdds
          ? getTitleOddsForTeam(team.teamName, kalshiOdds)
          : getFallbackTitleOdds(team.teamName, slug);
        const enriched = { ...team };
        if (isTitleTeam) {
          enriched.isTitleContender = true;
          if (titleOddsVal !== null) enriched.titleOdds = `${titleOddsVal}%`;
        }
        euroTeams.push(enriched);
      }
    }
  }

  // Sort by rank to maintain order
  euroTeams.sort((a, b) => a.rank - b.rank);

  // Build insight combining title race + european places info
  const titleTeams = euroTeams.filter(t => t.isTitleContender);
  const gamesLeft = leader.gamesRemaining || (totalGames - leader.gamesPlayed);
  const titleGap = titleTeams.length >= 2 ? leader.points - titleTeams[1].points : 0;
  const euroCutoffGap = lastEuroTeam && firstNonEuro ? lastEuroTeam.points - firstNonEuro.points : 0;

  let insight = "";
  // Title part of insight
  if (titleTeams.length === 1) {
    insight = `${leader.teamName} have the title all but wrapped up.`;
  } else if (titleTeams.length === 2) {
    insight = `Title race: ${titleTeams[0].teamName} lead ${titleTeams[1].teamName} by ${titleGap}pt${titleGap !== 1 ? "s" : ""}.`;
  } else if (titleTeams.length > 2) {
    insight = `${titleTeams.length}-way title fight, ${leader.teamName} lead by ${titleGap}pt${titleGap !== 1 ? "s" : ""}.`;
  }
  // Euro cutoff part
  if (euroCutoffGap <= 3) {
    insight += ` Tight race for Europe: only ${euroCutoffGap}pt${euroCutoffGap !== 1 ? "s" : ""} separate ${lastEuroTeam?.teamName} and ${firstNonEuro?.teamName}.`;
  }
  insight += ` ${gamesLeft} games remaining.`;

  battles.push({
    type: "european",
    label: "Title & European Places",
    teams: euroTeams.slice(0, 10),
    gapFromTarget: euroCutoffGap,
    insight: insight.trim(),
    isCompetitive: titleTeams.length >= 2 || euroCutoffGap <= 6,
  });

  // --- RELEGATION ---
  const totalTeams = standings.length;
  const relSpots = config.relegationSpots;
  const firstRelTeam = standings[totalTeams - relSpots]; // first team in relegation
  const lastSafeTeam = standings[totalTeams - relSpots - 1]; // last team above relegation

  const relTeams: StandingEntry[] = [];
  for (let i = standings.length - 1; i >= 0; i--) {
    const team = standings[i];
    const isInRelZone = team.zone?.toLowerCase().includes("relegation");
    const gapToSafety = lastSafeTeam ? lastSafeTeam.points - team.points : 0;
    // Include relegated teams + those within 6 points of the drop zone
    if (isInRelZone || (firstRelTeam && team.points - firstRelTeam.points <= 6 && team.rank >= totalTeams - relSpots - 3)) {
      // Enrich with relegation odds from Kalshi
      const relOdds = kalshiOdds
        ? getRelegationOddsForTeam(team.teamName, kalshiOdds)
        : null;
      const enriched = { ...team };
      if (relOdds !== null && relOdds > 0) {
        enriched.relegationOdds = `${relOdds}%`;
      }
      relTeams.push(enriched);
    }
  }
  relTeams.sort((a, b) => a.rank - b.rank);

  const relGap = lastSafeTeam && firstRelTeam ? lastSafeTeam.points - firstRelTeam.points : 0;
  const relInsight = relGap <= 3
    ? `Nail-biting at the bottom: just ${relGap} point${relGap !== 1 ? "s" : ""} between safety and the drop zone.`
    : `${lastSafeTeam?.teamName} are ${relGap} points above the relegation places.`;

  battles.push({
    type: "relegation",
    label: "Relegation Battle",
    teams: relTeams.slice(0, 7),
    gapFromTarget: relGap,
    insight: relInsight,
    isCompetitive: relGap <= 6,
  });

  return battles;
}

export async function fetchNews(slug: LeagueSlug): Promise<Article[]> {
  const cacheKey = `news:${slug}`;
  const cached = getCached<Article[]>(cacheKey, 15 * 60 * 1000);
  if (cached) return cached;

  try {
    const data = await fetchJSON(`${ESPN_BASE}/site/v2/sports/soccer/${slug}/news`);
    const articles: Article[] = (data?.articles || []).map((a: any) => ({
      id: String(a.id || ""),
      headline: a.headline || "",
      description: a.description || "",
      published: a.published || "",
      url: a.links?.web?.href || a.links?.api?.news?.href || "",
      imageUrl: a.images?.[0]?.url || undefined,
      source: "ESPN",
      type: a.type || "Article",
    }));

    setCache(cacheKey, articles);
    return articles;
  } catch (error) {
    console.error(`Error fetching news for ${slug}:`, error);
    return [];
  }
}

export async function fetchBBCNews(): Promise<Article[]> {
  const cacheKey = "bbc-news";
  const cached = getCached<Article[]>(cacheKey, 30 * 60 * 1000);
  if (cached) return cached;

  try {
    const res = await fetch("https://feeds.bbci.co.uk/sport/football/rss.xml");
    const text = await res.text();

    const articles: Article[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(text)) !== null) {
      const item = match[1];
      const getTag = (tag: string): string => {
        const m = item.match(new RegExp(`<${tag}[^>]*>(?:<!\\\[CDATA\\\[)?(.*?)(?:\\\]\\\]>)?</${tag}>`));
        return m ? m[1].trim() : "";
      };

      const mediaUrl = item.match(/url="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp))"/)?.[1] || "";

      articles.push({
        id: `bbc-${articles.length}`,
        headline: getTag("title"),
        description: getTag("description"),
        published: getTag("pubDate"),
        url: getTag("link"),
        imageUrl: mediaUrl || undefined,
        source: "BBC Sport",
        type: "Article",
      });
    }

    setCache(cacheKey, articles);
    return articles;
  } catch (error) {
    console.error("Error fetching BBC news:", error);
    return [];
  }
}

// Competition tracker: find which teams are still active in cup/European competitions
type CompEntry = { slug: string; name: string; shortName: string; stage?: string };

async function fetchActiveCompetitions(slug: LeagueSlug): Promise<Map<string, CompEntry[]>> {
  const cacheKey = `comps:${slug}`;
  const cached = getCached<Map<string, CompEntry[]>>(cacheKey, 60 * 60 * 1000); // 1hr cache for competitions
  if (cached) return cached;

  const teamComps = new Map<string, CompEntry[]>();

  // Determine which competitions to check
  const compSlugs = [...(LEAGUE_CUPS[slug] || []), ...EURO_COMPS];

  // For each competition, scan upcoming dates to find remaining teams
  const now = new Date();
  const dates: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }

  // Fetch each competition in parallel
  const compPromises = compSlugs.map(async (compSlug) => {
    const compConfig = COMPETITIONS[compSlug];
    if (!compConfig) return;

    try {
      // Check dates for upcoming fixtures
      // Daily for first 35 days (covers all near-term cup rounds), then every 5th day
      const results = await Promise.allSettled(
        dates.filter((_, i) => i <= 45 || i % 5 === 0).map(date =>
          fetchJSON(`${ESPN_BASE}/site/v2/sports/soccer/${compSlug}/scoreboard?dates=${date}`)
        )
      );

      const seenTeams = new Set<string>();

      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const events = result.value?.events || [];

        for (const event of events) {
          const stage = event.season?.slug || "";
          const stageLabel = stage.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
          const comps = event.competitions?.[0]?.competitors || [];

          for (const c of comps) {
            const teamId = c.team?.id;
            const teamName = c.team?.displayName || "";
            // Skip placeholder teams like "Round of 16 1 Winner"
            if (!teamId || teamName.includes("Winner") || teamName.includes("TBD")) continue;
            if (seenTeams.has(teamId)) continue;
            seenTeams.add(teamId);

            const entry: CompEntry = {
              slug: compSlug,
              name: compConfig.name,
              shortName: compConfig.shortName,
              stage: stageLabel || undefined,
            };

            const existing = teamComps.get(teamId) || [];
            // Don't add duplicate competitions
            if (!existing.some(e => e.slug === compSlug)) {
              existing.push(entry);
              teamComps.set(teamId, existing);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning competition ${compSlug}:`, error);
    }
  });

  await Promise.all(compPromises);
  setCache(cacheKey, teamComps);
  return teamComps;
}

export async function fetchLeagueData(slug: LeagueSlug): Promise<LeagueData> {
  const config = LEAGUES[slug];
  const [standings, recentMatches, upcomingMatches, news, activeComps, kalshiOdds] = await Promise.all([
    fetchStandings(slug),
    fetchRecentMatches(slug),
    fetchUpcomingMatches(slug),
    fetchNews(slug),
    fetchActiveCompetitions(slug),
    fetchLeagueOdds(slug).catch(() => null),
  ]);

  // Enrich standings with active competition data
  for (const team of standings) {
    const comps = activeComps.get(team.teamId);
    if (comps && comps.length > 0) {
      team.activeCompetitions = comps;
    }
  }

  const battles = computeBattles(standings, slug, kalshiOdds || undefined);
  const hasKalshiData = kalshiOdds !== null && (kalshiOdds.title.length > 0 || kalshiOdds.relegation.length > 0);

  return {
    slug,
    name: config.name,
    country: config.country,
    flag: config.flag,
    standings,
    recentMatches,
    upcomingMatches,
    news,
    battles,
    oddsSource: hasKalshiData ? "kalshi" : "fallback",
    lastUpdated: new Date().toISOString(),
  };
}

export async function fetchAllLeagues(): Promise<LeagueData[]> {
  const slugs = Object.keys(LEAGUES) as LeagueSlug[];
  const results = await Promise.all(slugs.map(fetchLeagueData));
  return results;
}
