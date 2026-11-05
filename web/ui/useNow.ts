import { useEffect, useState } from 'react';

/** The current time for relative stamps ("3m"), refreshed every half minute by default. */
export function useNow(interval = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}
