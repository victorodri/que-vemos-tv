"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROFILES, isProfileId, type ProfileId } from "@/config/profiles";
import { DEFAULT_FILTERS } from "@/lib/filters";
import type { Prefs } from "@/lib/prefs";
import { getJSON, toSaved } from "@/lib/client";
import { titleKey, type Filters, type MediaType, type Meta, type ProfileData, type SavedTitle, type Title } from "@/lib/types";
import { ForYouView } from "./ForYouView";
import { ListView } from "./ListView";
import { ProfilePicker } from "./ProfilePicker";
import { Questionnaire } from "./Questionnaire";
import { ProfileContext, type ProfileApi } from "./profileContext";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";
import { focusEl, focusFirst, useSpatialNav } from "./spatialNav";
import { SurpriseView } from "./SurpriseView";
import { DetailModal } from "./TitleFeature";

type Tab = "foryou" | "search" | "surprise" | "list" | "settings";
type Detail = { type: MediaType; id: number; preview?: Title | SavedTitle };
// El estado de navegación vive en el historial del navegador, así el botón «Atrás» del mando funciona.
type Nav = { profile: ProfileId | null; tab: Tab; detail: Detail | null };

const HOME: Nav = { profile: null, tab: "foryou", detail: null };
const LAST_PROFILE = "quevemos:lastProfile";

const TABS: { id: Tab; label: string }[] = [
  { id: "foryou", label: "Para ti" },
  { id: "search", label: "Buscar" },
  { id: "surprise", label: "🎲 Sorpréndeme" },
  { id: "list", label: "Mi lista" },
  { id: "settings", label: "Ajustes" },
];

function readLastProfile() {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

export default function App() {
  const [nav, setNav] = useState<Nav>(HOME);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ id: ProfileId; data: ProfileData } | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<Filters>(DEFAULT_FILTERS);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [redoQuiz, setRedoQuiz] = useState(false);
  const dirty = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);

  // ---------- Historial ----------
  useEffect(() => {
    setLastUsed(readLastProfile());
    const s = history.state as Nav | null;
    if (s && "tab" in s && (s.profile === null || isProfileId(s.profile))) setNav(s);
    else history.replaceState(HOME, "");
    const onPop = (e: PopStateEvent) => setNav((e.state as Nav | null) ?? HOME);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const push = (next: Nav) => {
    history.pushState(next, "");
    setNav(next);
  };
  const replace = (next: Nav) => {
    history.replaceState(next, "");
    setNav(next);
  };

  const back = useCallback(() => {
    if (nav.profile) history.back();
  }, [nav.profile]);
  useSpatialNav(back);

  // ---------- Datos ----------
  useEffect(() => {
    getJSON<Meta>("/api/meta").then(setMeta, (e) => setMetaError(e.message));
  }, []);

  const save = (p: { id: ProfileId; data: ProfileData }) => {
    dirty.current = false;
    fetch(`/api/profile/${p.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p.data),
      keepalive: true,
    }).catch(() => (dirty.current = true));
  };

  useEffect(() => {
    if (!nav.profile || profile?.id === nav.profile) return;
    const id = nav.profile;
    if (profile && dirty.current) save(profile); // no perder cambios del perfil anterior
    setProfile(null);
    setProfileError(null);
    getJSON<ProfileData>(`/api/profile/${id}`).then(
      (data) => {
        setProfile({ id, data });
        setFiltersState({ ...DEFAULT_FILTERS, ...data.lastFilters });
      },
      (e) => setProfileError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.profile]);

  // Guardado con retardo: agrupa varios cambios seguidos en una sola petición.
  useEffect(() => {
    if (!dirty.current || !profile) return;
    const t = setTimeout(() => save(profile), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const update = useCallback((fn: (d: ProfileData) => ProfileData) => {
    dirty.current = true;
    setProfile((p) => (p ? { ...p, data: fn(p.data) } : p));
  }, []);

  const api = useMemo<ProfileApi | null>(() => {
    if (!profile) return null;
    const seen = new Set(profile.data.seen);
    const listed = new Set(profile.data.watchlist.map(titleKey));
    return {
      id: profile.id,
      data: profile.data,
      inList: (t) => listed.has(titleKey(t)),
      isSeen: (t) => seen.has(titleKey(t)),
      toggleList: (t) =>
        update((d) => {
          const k = titleKey(t);
          return d.watchlist.some((w) => titleKey(w) === k)
            ? { ...d, watchlist: d.watchlist.filter((w) => titleKey(w) !== k) }
            : { ...d, watchlist: [...d.watchlist, toSaved(t)] };
        }),
      toggleSeen: (t) =>
        update((d) => {
          const k = titleKey(t);
          return d.seen.includes(k) ? { ...d, seen: d.seen.filter((s) => s !== k) } : { ...d, seen: [...d.seen, k] };
        }),
      setPlatforms: (platforms) => update((d) => ({ ...d, platforms })),
      clearSeen: () => update((d) => ({ ...d, seen: [] })),
      setLastFilters: (lastFilters) => update((d) => ({ ...d, lastFilters })),
    };
  }, [profile, update]);

  const setFilters = (f: Filters) => {
    setFiltersState(f);
    api?.setLastFilters(f);
  };

  // ---------- Acciones ----------
  const pickProfile = (id: ProfileId) => {
    try {
      localStorage.setItem(LAST_PROFILE, id);
    } catch {}
    setLastUsed(id);
    setRedoQuiz(false);
    push({ profile: id, tab: "foryou", detail: null });
  };

  // Al terminar el cuestionario se guarda al momento: las recomendaciones las calcula el servidor con estos gustos.
  const finishQuiz = (prefs: Prefs, platforms: number[]) => {
    if (!profile) return;
    const f: Filters = { ...DEFAULT_FILTERS, type: prefs.types[0], onlyMine: platforms.length > 0 };
    const next = { ...profile, data: { ...profile.data, prefs, platforms, lastFilters: f } };
    setProfile(next);
    save(next);
    setFiltersState(f);
    setRedoQuiz(false);
    replace({ ...nav, tab: "foryou", detail: null });
  };

  const openDetail = (t: Title | SavedTitle) => {
    openerRef.current = document.activeElement as HTMLElement | null;
    push({ ...nav, detail: { type: t.type, id: t.id, preview: t } });
  };

  // Al cerrar la ficha, el foco vuelve a la tarjeta que la abrió.
  const hadDetail = useRef(false);
  useEffect(() => {
    if (hadDetail.current && !nav.detail) {
      const el = openerRef.current;
      requestAnimationFrame(() => (el && document.contains(el) ? focusEl(el) : focusFirst()));
    }
    hadDetail.current = Boolean(nav.detail);
  }, [nav.detail]);

  // Al entrar en un perfil, foco en la primera pestaña.
  useEffect(() => {
    if (api && !nav.detail) requestAnimationFrame(focusFirst);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api?.id, redoQuiz, Boolean(api?.data.prefs)]);

  // ---------- Render ----------
  if (!nav.profile) return <ProfilePicker lastUsed={lastUsed} onPick={pickProfile} />;

  const current = PROFILES.find((p) => p.id === nav.profile)!;
  const error = metaError ?? profileError;

  if (api && meta && (!api.data.prefs || redoQuiz)) {
    return (
      <Questionnaire
        key={`${api.id}:${redoQuiz}`}
        name={current.name}
        pareja={api.id === "pareja"}
        meta={meta}
        initial={api.data.prefs}
        initialPlatforms={api.data.platforms}
        onDone={finishQuiz}
        onCancel={api.data.prefs ? () => setRedoQuiz(false) : undefined}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">
          Qué <span>Vemos</span>
        </h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className="tab" aria-current={nav.tab === t.id ? "page" : undefined} data-autofocus={nav.tab === t.id || undefined} onClick={() => replace({ ...nav, tab: t.id, detail: null })}>
              {t.label}
              {t.id === "list" && api ? ` (${api.data.watchlist.length})` : ""}
            </button>
          ))}
        </nav>
        <button className="who" onClick={() => push(HOME)} title="Cambiar de perfil">
          <span className="avatar avatar--small" style={{ background: current.color }}>
            {current.initials}
          </span>
          <span className="who-name">{current.name}</span>
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!error && (!api || !meta) && <p className="loading">Cargando…</p>}

      {api && meta && (
        <ProfileContext.Provider value={api}>
          <main inert={nav.detail ? true : undefined}>
            {nav.tab === "foryou" && <ForYouView onOpen={openDetail} onRedo={() => setRedoQuiz(true)} />}
            {nav.tab === "search" && <SearchView filters={filters} onFilters={setFilters} meta={meta} onOpen={openDetail} />}
            {nav.tab === "surprise" && <SurpriseView filters={filters} onFilters={setFilters} meta={meta} />}
            {nav.tab === "list" && <ListView onOpen={openDetail} />}
            {nav.tab === "settings" && <SettingsView meta={meta} onRedo={() => setRedoQuiz(true)} />}
          </main>
          {nav.detail && <DetailModal key={`${nav.detail.type}:${nav.detail.id}`} target={nav.detail} onClose={back} />}
        </ProfileContext.Provider>
      )}
    </div>
  );
}
