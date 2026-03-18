import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { EuropeanCupData, CupTie, CupRound, CupFavorite, CupMatch } from "@shared/schema";
import { Link } from "wouter";
import { RefreshCw, Trophy, ArrowLeft, ChevronRight, Clock, Check, Swords, Crown, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";
import { useAutoRefresh } from "@/hooks/use-auto-refresh";
import { formatDistanceToNow, format, isToday, isTomorrow } from "date-fns";
import { useState } from "react";

// Competition color schemes
const COMP_THEMES: Record<string, { accent: string; accentBg: string; accentBorder: string; badge: string }> = {
  UCL: {
    accent: "text-blue-400",
    accentBg: "bg-blue-600/15",
    accentBorder: "border-blue-500/30",
    badge: "bg-blue-600/20 text-blue-300 border-blue-500/30",
  },
  UEL: {
    accent: "text-orange-400",
    accentBg: "bg-orange-600/15",
    accentBorder: "border-orange-500/30",
    badge: "bg-orange-600/20 text-orange-300 border-orange-500/30",
  },
  UECL: {
    accent: "text-green-400",
    accentBg: "bg-green-600/15",
    accentBorder: "border-green-500/30",
    badge: "bg-green-600/20 text-green-300 border-green-500/30",
  },
};

// Format match date
function formatMatchDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isToday(d)) return `Today ${format(d, "h:mm a")}`;
  if (isTomorrow(d)) return `Tomorrow ${format(d, "h:mm a")}`;
  return format(d, "MMM d, h:mm a");
}

function getStatusLabel(status: string): { label: string; color: string } {
  switch (status) {
    case "STATUS_FULL_TIME":
    case "STATUS_FINAL_AET":
    case "STATUS_FINAL_PEN":
      return { label: "FT", color: "text-muted-foreground" };
    case "STATUS_IN_PROGRESS":
    case "STATUS_HALFTIME":
    case "STATUS_FIRST_HALF":
    case "STATUS_SECOND_HALF":
      return { label: "LIVE", color: "text-green-400" };
    case "STATUS_SCHEDULED":
      return { label: "", color: "text-muted-foreground" };
    default:
      return { label: status.replace("STATUS_", ""), color: "text-muted-foreground" };
  }
}

// ---- Tie Card: Shows a matchup between two teams ----
// Get the primary odds to display: advance odds take priority, then tournament odds
function getDisplayOdds(tie: CupTie): { team1: number | null; team2: number | null; isAdvance: boolean; source: string } {
  if (tie.team1AdvanceOdds != null || tie.team2AdvanceOdds != null) {
    return {
      team1: tie.team1AdvanceOdds ?? null,
      team2: tie.team2AdvanceOdds ?? null,
      isAdvance: true,
      source: tie.advanceOddsSource === "kalshi" ? "Kalshi" : "implied",
    };
  }
  return {
    team1: tie.team1TournamentOdds ?? null,
    team2: tie.team2TournamentOdds ?? null,
    isAdvance: false,
    source: "tournament",
  };
}

function TieCard({ tie, theme }: { tie: CupTie; theme: typeof COMP_THEMES["UCL"] }) {
  const isComplete = tie.isComplete;
  const team1Won = tie.winner === tie.team1.id;
  const team2Won = tie.winner === tie.team2.id;
  const odds = getDisplayOdds(tie);

  return (
    <div className={`rounded-lg border ${isComplete ? "border-border/50" : "border-border"} bg-card overflow-hidden`}>
      {/* Team rows */}
      <div className="divide-y divide-border/50">
        {/* Team 1 */}
        <div className={`flex items-center gap-2 px-3 py-2 ${team1Won ? theme.accentBg : ""} ${!isComplete ? "" : team1Won ? "" : "opacity-50"}`}>
          <img src={tie.team1.logo} alt="" className="w-5 h-5 object-contain" loading="lazy" crossOrigin="anonymous" />
          <span className={`text-xs font-medium flex-1 truncate ${team1Won ? "text-foreground" : "text-foreground/80"}`}>
            {tie.team1.name}
          </span>
          {odds.team1 != null && odds.team1 > 0 && !isComplete && (
            <span className={`text-[8px] font-bold px-1 py-0 rounded border leading-tight ${
              odds.isAdvance
                ? (odds.team1 >= 60 ? "bg-green-600/20 text-green-300 border-green-500/30" : odds.team1 <= 30 ? "bg-red-600/15 text-red-300 border-red-500/30" : theme.badge)
                : theme.badge
            }`}>
              {odds.team1}%
            </span>
          )}
          {/* Aggregate goals for team1 */}
          {tie.aggregateScore && (
            <span className={`text-xs font-semibold tabular-nums w-4 text-center ${team1Won ? "text-foreground" : "text-muted-foreground"}`}>
              {tie.aggregateScore.split("-")[0]}
            </span>
          )}
          {team1Won && <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />}
        </div>
        {/* Team 2 */}
        <div className={`flex items-center gap-2 px-3 py-2 ${team2Won ? theme.accentBg : ""} ${!isComplete ? "" : team2Won ? "" : "opacity-50"}`}>
          <img src={tie.team2.logo} alt="" className="w-5 h-5 object-contain" loading="lazy" crossOrigin="anonymous" />
          <span className={`text-xs font-medium flex-1 truncate ${team2Won ? "text-foreground" : "text-foreground/80"}`}>
            {tie.team2.name}
          </span>
          {odds.team2 != null && odds.team2 > 0 && !isComplete && (
            <span className={`text-[8px] font-bold px-1 py-0 rounded border leading-tight ${
              odds.isAdvance
                ? (odds.team2 >= 60 ? "bg-green-600/20 text-green-300 border-green-500/30" : odds.team2 <= 30 ? "bg-red-600/15 text-red-300 border-red-500/30" : theme.badge)
                : theme.badge
            }`}>
              {odds.team2}%
            </span>
          )}
          {tie.aggregateScore && (
            <span className={`text-xs font-semibold tabular-nums w-4 text-center ${team2Won ? "text-foreground" : "text-muted-foreground"}`}>
              {tie.aggregateScore.split("-")[1]}
            </span>
          )}
          {team2Won && <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />}
        </div>
      </div>

      {/* Match details */}
      <div className="px-3 py-1.5 bg-muted/30 border-t border-border/50">
        {tie.matches.map((match, i) => (
          <MatchLine key={match.id} match={match} index={i} />
        ))}
        {tie.aggregateNote && (
          <p className="text-[9px] text-muted-foreground mt-0.5 italic">{tie.aggregateNote}</p>
        )}
      </div>
    </div>
  );
}

function MatchLine({ match, index }: { match: CupMatch; index: number }) {
  const status = getStatusLabel(match.status);
  const isScheduled = match.status === "STATUS_SCHEDULED";

  return (
    <div className="flex items-center gap-1.5 py-0.5 text-[10px]">
      <span className="text-muted-foreground/60 w-9 flex-shrink-0">{match.leg || `Leg ${index + 1}`}</span>
      {isScheduled ? (
        <>
          <span className="text-muted-foreground flex-1">{match.homeTeam.abbreviation} vs {match.awayTeam.abbreviation}</span>
          <Clock className="w-2.5 h-2.5 text-muted-foreground/50" />
          <span className="text-muted-foreground/60">{formatMatchDate(match.date)}</span>
        </>
      ) : (
        <>
          <span className="text-foreground/80 flex-1">
            {match.homeTeam.abbreviation} {match.homeTeam.score} <Minus className="w-2 h-2 inline text-muted-foreground/50" /> {match.awayTeam.score} {match.awayTeam.abbreviation}
          </span>
          <span className={`${status.color} font-medium`}>{status.label}</span>
        </>
      )}
      {match.odds && !isScheduled && (
        <span className="text-muted-foreground/40 text-[8px] ml-1">
          {match.odds.homeMoneyline}/{match.odds.drawMoneyline}/{match.odds.awayMoneyline}
        </span>
      )}
    </div>
  );
}

// ---- Round Section ----
function RoundSection({ round, theme }: { round: CupRound; theme: typeof COMP_THEMES["UCL"] }) {
  if (round.ties.length === 0) {
    return (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <h3 className={`text-xs font-medium uppercase tracking-wider ${theme.accent}`}>{round.name}</h3>
          <span className="text-[10px] text-muted-foreground/50 italic">Upcoming</span>
        </div>
        <div className="border border-dashed border-border/40 rounded-lg px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground/50">Draw not yet confirmed</p>
        </div>
      </div>
    );
  }

  const completeTies = round.ties.filter(t => t.isComplete);
  const activeTies = round.ties.filter(t => !t.isComplete);

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <h3 className={`text-xs font-medium uppercase tracking-wider ${theme.accent}`}>{round.name}</h3>
        {round.isCurrent && (
          <Badge className={`text-[8px] px-1.5 py-0 ${theme.badge}`}>Current</Badge>
        )}
        <span className="text-[10px] text-muted-foreground/50">
          {completeTies.length}/{round.ties.length} decided
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {/* Active ties first, then completed */}
        {activeTies.map((tie, i) => <TieCard key={`active-${i}`} tie={tie} theme={theme} />)}
        {completeTies.map((tie, i) => <TieCard key={`done-${i}`} tie={tie} theme={theme} />)}
      </div>
    </div>
  );
}

// ---- Tournament Favorites ----
function FavoritesPanel({ favorites, theme, shortName }: { favorites: CupFavorite[]; theme: typeof COMP_THEMES["UCL"]; shortName: string }) {
  const activeFavs = favorites.filter(f => !f.isEliminated && f.tournamentOdds > 0);
  const eliminatedFavs = favorites.filter(f => f.isEliminated && f.tournamentOdds > 0);

  return (
    <Card className="bg-card border-card-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Crown className={`w-3.5 h-3.5 ${theme.accent}`} />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Win {shortName}</span>
          <span className="text-[10px] text-muted-foreground/50 ml-auto">via Kalshi</span>
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {activeFavs.map((fav, i) => (
          <div key={fav.team.id} className="flex items-center gap-2 px-4 py-2">
            <span className="text-[10px] text-muted-foreground tabular-nums w-4">{i + 1}</span>
            {fav.team.logo && (
              <img src={fav.team.logo} alt="" className="w-4 h-4 object-contain" loading="lazy" crossOrigin="anonymous" />
            )}
            <span className="text-xs font-medium text-foreground flex-1 truncate">{fav.team.name}</span>
            <div className="flex items-center gap-1.5">
              <div className={`h-1.5 rounded-full ${theme.accentBg.replace("/15", "/40")}`} style={{ width: `${Math.max(fav.tournamentOdds * 1.5, 6)}px` }} />
              <span className={`text-xs font-semibold tabular-nums ${theme.accent}`}>{fav.tournamentOdds}%</span>
            </div>
          </div>
        ))}
      </div>
      {eliminatedFavs.length > 0 && (
        <div className="px-4 py-2 border-t border-border bg-muted/20">
          <p className="text-[10px] text-muted-foreground/60 mb-1">Eliminated</p>
          <div className="flex flex-wrap gap-2">
            {eliminatedFavs.slice(0, 6).map(fav => (
              <span key={fav.team.id} className="text-[10px] text-muted-foreground/40 line-through">
                {fav.team.name}{fav.eliminatedBy ? ` (by ${fav.eliminatedBy})` : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---- Competition Card (overview mode) ----
function CompetitionOverview({ cup }: { cup: EuropeanCupData }) {
  const theme = COMP_THEMES[cup.shortName] || COMP_THEMES.UCL;
  const currentRound = cup.rounds.find(r => r.isCurrent);
  const activeTies = currentRound?.ties.filter(t => !t.isComplete) || [];
  const completedTies = currentRound?.ties.filter(t => t.isComplete) || [];
  const topFavs = cup.favorites.filter(f => !f.isEliminated && f.tournamentOdds > 0).slice(0, 5);

  return (
    <Card className="bg-card border-card-border overflow-hidden" data-testid={`cup-card-${cup.slug}`}>
      {/* Header */}
      <Link href={`/cup/${encodeURIComponent(cup.slug)}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border hover:bg-accent/50 transition-colors cursor-pointer group">
          <div className="flex items-center gap-3">
            <span className="text-xl">{cup.slug === "uefa.champions" ? "⭐" : cup.slug === "uefa.europa" ? "🟠" : "🟢"}</span>
            <div>
              <h2 className="font-semibold text-sm text-foreground">{cup.name}</h2>
              <p className="text-xs text-muted-foreground">{cup.currentRound}</p>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        </div>
      </Link>

      {/* Current round matchups */}
      {currentRound && (
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <Swords className={`w-3.5 h-3.5 ${theme.accent}`} />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{currentRound.name}</span>
            <span className="text-[10px] text-muted-foreground/50 ml-auto">
              {completedTies.length}/{currentRound.ties.length} decided
            </span>
          </div>
          <div className="space-y-1.5">
            {/* Show active ties first */}
            {activeTies.map((tie, i) => (
              <TieRow key={`active-${i}`} tie={tie} theme={theme} />
            ))}
            {completedTies.map((tie, i) => (
              <TieRow key={`done-${i}`} tie={tie} theme={theme} />
            ))}
          </div>
        </div>
      )}

      {/* Top favorites */}
      {topFavs.length > 0 && (
        <div className="px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <Crown className={`w-3.5 h-3.5 ${theme.accent}`} />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Favorites</span>
          </div>
          <div className="space-y-1">
            {topFavs.map((fav, i) => (
              <div key={fav.team.id} className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground tabular-nums w-3">{i + 1}</span>
                {fav.team.logo && (
                  <img src={fav.team.logo} alt="" className="w-3.5 h-3.5 object-contain" loading="lazy" crossOrigin="anonymous" />
                )}
                <span className="text-[11px] text-foreground/80 flex-1 truncate">{fav.team.name}</span>
                <span className={`text-[11px] font-semibold tabular-nums ${theme.accent}`}>{fav.tournamentOdds}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// Compact tie row for overview
function TieRow({ tie, theme }: { tie: CupTie; theme: typeof COMP_THEMES["UCL"] }) {
  const team1Won = tie.winner === tie.team1.id;
  const team2Won = tie.winner === tie.team2.id;
  const isLive = tie.matches.some(m => m.status.includes("PROGRESS") || m.status.includes("HALF"));

  // Find next scheduled match for upcoming info
  const nextMatch = tie.matches.find(m => m.status === "STATUS_SCHEDULED");

  return (
    <div className={`flex items-center gap-1.5 py-1.5 px-2 rounded text-xs ${tie.isComplete ? "bg-muted/20" : isLive ? "bg-green-500/5 border border-green-500/20" : "bg-muted/10"}`}>
      {/* Team 1 */}
      <img src={tie.team1.logo} alt="" className="w-3.5 h-3.5 object-contain flex-shrink-0" loading="lazy" crossOrigin="anonymous" />
      <span className={`truncate ${team1Won ? "font-semibold text-foreground" : tie.isComplete && !team1Won ? "text-muted-foreground/50 line-through" : "text-foreground/80"}`}>
        {tie.team1.abbreviation}
      </span>
      {(() => { const odds = getDisplayOdds(tie); return odds.team1 != null && odds.team1 > 0 && !tie.isComplete ? (
        <span className={`text-[7px] font-bold px-0.5 rounded border leading-tight ${
          odds.isAdvance
            ? (odds.team1 >= 60 ? "bg-green-600/20 text-green-300 border-green-500/30" : odds.team1 <= 30 ? "bg-red-600/15 text-red-300 border-red-500/30" : theme.badge)
            : theme.badge
        }`}>{odds.team1}%</span>
      ) : null; })()}

      {/* Score / VS */}
      <span className="text-muted-foreground/50 mx-0.5 flex-shrink-0">
        {tie.aggregateScore ? (
          <span className="tabular-nums font-medium text-foreground/60">{tie.aggregateScore}</span>
        ) : (
          "vs"
        )}
      </span>

      {/* Team 2 */}
      <img src={tie.team2.logo} alt="" className="w-3.5 h-3.5 object-contain flex-shrink-0" loading="lazy" crossOrigin="anonymous" />
      <span className={`truncate ${team2Won ? "font-semibold text-foreground" : tie.isComplete && !team2Won ? "text-muted-foreground/50 line-through" : "text-foreground/80"}`}>
        {tie.team2.abbreviation}
      </span>
      {(() => { const odds = getDisplayOdds(tie); return odds.team2 != null && odds.team2 > 0 && !tie.isComplete ? (
        <span className={`text-[7px] font-bold px-0.5 rounded border leading-tight ${
          odds.isAdvance
            ? (odds.team2 >= 60 ? "bg-green-600/20 text-green-300 border-green-500/30" : odds.team2 <= 30 ? "bg-red-600/15 text-red-300 border-red-500/30" : theme.badge)
            : theme.badge
        }`}>{odds.team2}%</span>
      ) : null; })()}

      <div className="flex-1" />

      {/* Status */}
      {tie.isComplete ? (
        <Check className="w-3 h-3 text-green-500/60 flex-shrink-0" />
      ) : isLive ? (
        <span className="text-[9px] font-medium text-green-400">LIVE</span>
      ) : nextMatch ? (
        <span className="text-[9px] text-muted-foreground/50">{formatMatchDate(nextMatch.date)}</span>
      ) : null}
    </div>
  );
}

// ---- Competition Detail Page ----
function CompetitionDetail({ cup }: { cup: EuropeanCupData }) {
  const theme = COMP_THEMES[cup.shortName] || COMP_THEMES.UCL;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Bracket / Rounds */}
        <div className="lg:col-span-2">
          {cup.rounds.map((round) => (
            <RoundSection key={round.name} round={round} theme={theme} />
          ))}
        </div>

        {/* Right: Tournament Favorites */}
        <div>
          <FavoritesPanel favorites={cup.favorites} theme={theme} shortName={cup.shortName} />
        </div>
      </div>
    </div>
  );
}

// ---- Skeleton ----
function CupCardSkeleton() {
  return (
    <Card className="bg-card border-card-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Skeleton className="w-6 h-6 rounded" />
          <div>
            <Skeleton className="w-28 h-4 mb-1" />
            <Skeleton className="w-16 h-3" />
          </div>
        </div>
      </div>
      {[...Array(4)].map((_, i) => (
        <div key={i} className="px-4 py-2 border-b border-border/50">
          <Skeleton className="w-full h-6" />
        </div>
      ))}
    </Card>
  );
}

// ---- Main Page ----
export default function EuropeanCups() {
  const { refetchInterval } = useAutoRefresh();
  const [selectedCup, setSelectedCup] = useState<string | null>(null);

  const { data: cups, isLoading, error, dataUpdatedAt } = useQuery<EuropeanCupData[]>({
    queryKey: ["/api/european-cups"],
    refetchInterval,
    staleTime: 60_000,
  });

  const activeCup = selectedCup ? cups?.find(c => c.slug === selectedCup) : null;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <div className="flex items-center gap-2 cursor-pointer group">
                <svg viewBox="0 0 32 32" className="w-7 h-7" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Euro Football Hub">
                  <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" className="text-primary"/>
                  <path d="M16 4 L16 28 M4 16 L28 16" stroke="currentColor" strokeWidth="1.5" opacity="0.3" className="text-primary"/>
                  <circle cx="16" cy="16" r="6" stroke="currentColor" strokeWidth="2" className="text-primary"/>
                  <circle cx="16" cy="16" r="1.5" fill="currentColor" className="text-primary"/>
                </svg>
                <div>
                  <h1 className="text-base font-bold text-foreground tracking-tight">Euro Football Hub</h1>
                  <p className="text-[10px] text-muted-foreground">European Competitions</p>
                </div>
              </div>
            </Link>
          </div>

          {/* Nav tabs */}
          <div className="flex items-center gap-1">
            <Link href="/">
              <span className="text-xs px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">
                Leagues
              </span>
            </Link>
            <span className="text-xs px-3 py-1.5 rounded-md bg-accent text-foreground font-medium cursor-default">
              Cups
            </span>
          </div>

          <div className="flex items-center gap-3">
            {dataUpdatedAt > 0 && (
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <RefreshCw className="w-3 h-3" />
                <span>Updated {formatDistanceToNow(dataUpdatedAt, { addSuffix: true })}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {error && (
          <div className="text-center py-12">
            <p className="text-destructive text-sm">Failed to load data. Retrying...</p>
          </div>
        )}

        {/* Detail view */}
        {activeCup ? (
          <div>
            <button
              onClick={() => setSelectedCup(null)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4 transition-colors"
              data-testid="back-to-cups"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to all competitions
            </button>
            <div className="flex items-center gap-3 mb-6">
              <span className="text-2xl">{activeCup.slug === "uefa.champions" ? "⭐" : activeCup.slug === "uefa.europa" ? "🟠" : "🟢"}</span>
              <div>
                <h2 className="text-lg font-bold text-foreground">{activeCup.name}</h2>
                <p className="text-xs text-muted-foreground">{activeCup.currentRound}</p>
              </div>
            </div>
            <CompetitionDetail cup={activeCup} />
          </div>
        ) : (
          /* Overview: all 3 competitions */
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {isLoading
              ? [...Array(3)].map((_, i) => <CupCardSkeleton key={i} />)
              : cups?.map(cup => (
                  <div key={cup.slug} onClick={() => setSelectedCup(cup.slug)} className="cursor-pointer">
                    <CompetitionOverview cup={cup} />
                  </div>
                ))
            }
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-4 py-4">
        <div className="max-w-7xl mx-auto px-4 flex items-center justify-between">
          <p className="text-[10px] text-muted-foreground">Data from ESPN. Tournament odds via <a href="https://kalshi.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Kalshi</a>.</p>
          <PerplexityAttribution />
        </div>
      </footer>
    </div>
  );
}
