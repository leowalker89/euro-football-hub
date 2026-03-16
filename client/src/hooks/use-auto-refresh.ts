import { useState, useEffect } from "react";

function isMatchDay(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const hour = now.getUTCHours();

  // Domestic match days: Fri(5), Sat(6), Sun(0), Mon(1)
  // European competition: Tue(2), Wed(3), Thu(4)
  // Basically any day can have matches, but peak hours matter
  
  // During typical European match hours (11:00 - 23:00 UTC)
  // covers early Saturday kickoffs through late Sunday/midweek games
  if (hour >= 11 && hour <= 23) {
    return true; // During active hours, always refresh frequently
  }
  
  return false;
}

export function useAutoRefresh() {
  const [refetchInterval, setRefetchInterval] = useState<number | false>(false);

  useEffect(() => {
    function updateInterval() {
      if (isMatchDay()) {
        setRefetchInterval(5 * 60 * 1000); // 5 minutes during match hours
      } else {
        setRefetchInterval(60 * 60 * 1000); // 1 hour off-peak
      }
    }

    updateInterval();
    
    // Re-check every 15 minutes whether we should change intervals
    const timer = setInterval(updateInterval, 15 * 60 * 1000);
    
    return () => clearInterval(timer);
  }, []);

  return { refetchInterval, isMatchDay: isMatchDay() };
}
