import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import type { StatusSnapshot, TaxonomyCategory } from './types';

export interface Toast {
  id: number;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface AppContextValue {
  status: StatusSnapshot | null;
  taxonomy: TaxonomyCategory[];
  taxonomyById: Record<string, TaxonomyCategory>;
  loading: boolean;
  loadError: string | null;
  refreshStatus: () => Promise<void>;
  demoMode: boolean;
  setDemoMode: (value: boolean) => void;
  notify: (message: string, type?: Toast['type']) => void;
  toasts: Toast[];
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}

let toastSequence = 1;

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [taxonomy, setTaxonomy] = useState<TaxonomyCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [demoMode, setDemoModeState] = useState<boolean>(
    () => window.localStorage.getItem('tm-demo-mode') === 'true',
  );

  const notify = useCallback((message: string, type: Toast['type'] = 'success') => {
    const id = toastSequence++;
    setToasts((current) => [...current, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, type === 'error' ? 8000 : 5000);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await api<StatusSnapshot>('/api/status');
      setStatus(nextStatus);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load application status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    api<{ categories: TaxonomyCategory[] }>('/api/taxonomy')
      .then((result) => setTaxonomy(result.categories))
      .catch(() => setTaxonomy([]));
  }, [refreshStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const setDemoMode = useCallback((value: boolean) => {
    setDemoModeState(value);
    window.localStorage.setItem('tm-demo-mode', String(value));
  }, []);

  const taxonomyById = useMemo(
    () => Object.fromEntries(taxonomy.map((category) => [category.id, category])),
    [taxonomy],
  );

  const value: AppContextValue = {
    status,
    taxonomy,
    taxonomyById,
    loading,
    loadError,
    refreshStatus,
    demoMode,
    setDemoMode,
    notify,
    toasts,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
