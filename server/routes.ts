import type { Express } from "express";
import { createServer, type Server } from "http";
import { LEAGUES, EURO_CUP_CONFIG, leagueSlugs, type LeagueSlug } from "@shared/schema";
import { fetchAllLeagues, fetchLeagueData, fetchBBCNews } from "./espn";
import { fetchAllEuropeanCups, fetchEuropeanCupData } from "./european-cups";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Dashboard: all leagues overview
  app.get("/api/dashboard", async (_req, res) => {
    try {
      const leagues = await fetchAllLeagues();
      res.json({
        leagues,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Dashboard fetch error:", error);
      res.status(500).json({ error: "Failed to fetch dashboard data" });
    }
  });

  // Single league detail
  app.get("/api/league/:slug", async (req, res) => {
    const slug = req.params.slug as LeagueSlug;
    if (!leagueSlugs.includes(slug)) {
      res.status(404).json({ error: "League not found" });
      return;
    }

    try {
      const data = await fetchLeagueData(slug);
      res.json(data);
    } catch (error) {
      console.error(`League fetch error for ${slug}:`, error);
      res.status(500).json({ error: "Failed to fetch league data" });
    }
  });

  // BBC news feed
  app.get("/api/news/bbc", async (_req, res) => {
    try {
      const articles = await fetchBBCNews();
      res.json(articles);
    } catch (error) {
      console.error("BBC news fetch error:", error);
      res.status(500).json({ error: "Failed to fetch BBC news" });
    }
  });

  // League config
  app.get("/api/leagues", (_req, res) => {
    res.json(LEAGUES);
  });

  // European Cups: all competitions
  app.get("/api/european-cups", async (_req, res) => {
    try {
      const cups = await fetchAllEuropeanCups();
      res.json(cups);
    } catch (error) {
      console.error("European cups fetch error:", error);
      res.status(500).json({ error: "Failed to fetch European cups data" });
    }
  });

  // Single European cup detail
  app.get("/api/european-cup/:slug", async (req, res) => {
    const slug = req.params.slug;
    const fullSlug = slug.startsWith("uefa.") ? slug : `uefa.${slug}`;
    if (!EURO_CUP_CONFIG[fullSlug]) {
      res.status(404).json({ error: "Competition not found" });
      return;
    }
    try {
      const data = await fetchEuropeanCupData(fullSlug);
      res.json(data);
    } catch (error) {
      console.error(`European cup fetch error for ${fullSlug}:`, error);
      res.status(500).json({ error: "Failed to fetch competition data" });
    }
  });

  return httpServer;
}
