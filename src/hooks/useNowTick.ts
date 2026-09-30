import { useEffect, useState } from 'react';

/** 주기적으로 리렌더를 유발해 "n초 전" 같은 상대 시간 표시를 갱신시킨다. */
export function useNowTick(intervalMs: number = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
