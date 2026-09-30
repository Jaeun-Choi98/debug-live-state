import { useCallback, useEffect, useState } from 'react';
import { loadEndpointConfigs } from '../config/configLoader';
import { EndpointConfig } from '../config/types';

export interface UseEndpointsConfigResult {
  endpoints: EndpointConfig[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useEndpointsConfig(): UseEndpointsConfigResult {
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadEndpointConfigs();
      setEndpoints(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEndpoints([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { endpoints, loading, error, reload: load };
}
