"use client";
import { useEffect, useRef, useState } from "react";
import { getJSON } from "@/lib/client";
import type { Title } from "@/lib/types";

interface PageResult {
  items: Title[];
  page: number;
  totalPages: number;
}

/** Carga /api/titles por páginas. Vuelve a la página 1 cada vez que cambia `query`. */
export function useTitles(query: string) {
  const [items, setItems] = useState<Title[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  async function load(nextPage: number) {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await getJSON<PageResult>(`/api/titles?${query}&page=${nextPage}`, ctrl.signal);
      setItems((prev) => (nextPage === 1 ? res.items : [...prev, ...res.items]));
      setPage(res.page);
      setTotalPages(res.totalPages);
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => load(1), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return { items, loading, error, hasMore: page < totalPages, loadMore: () => load(page + 1) };
}
