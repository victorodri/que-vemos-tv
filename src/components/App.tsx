"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_FILTERS } from "@/lib/filters";
import type { Prefs } from "@/lib/prefs";
import type { ImplicitEvent, Signal } from "@/lib/reco/types";
import { authHeaders, getJSON, HttpError, rememberToken, sendJSON, setActiveToken, tokenOf, toSaved } from "@/lib/client";
import type { PublicProfile } from "@/lib/profiles";
import { titleKey, type Filters, type MediaType, type Meta, type ProfileData, type SavedTitle, type Title } from "@/lib/types";
import { ForYouView } from "./ForYouView";
import { ListView } from "./ListView";
import { CommunityView } from "./CommunityView";
import { PinPad } from "./PinPad";
import { ProfileCreator } from "./ProfileCreator";
import { Avatar, ProfilePicker } from "./ProfilePicker";
import { Questionnaire, type QuizRatings } from "./Questionnaire";
import { ProfileContext, type ProfileApi } from "./profileContext";
import { SearchView } from "./SearchView";
import { SeenView } from "./SeenView";
import { SettingsView } from "./SettingsView";
import { focusEl, focusFirst, focusables, runBack, useSpatialNav } from "./spatialNav";
import { SurpriseView } from "./SurpriseView";
import { DetailModal } from "./TitleFeature";

type Tab = "foryou" | "search" | "surprise" | "community" | "list" | "seen" | "settings";
type ProfileId = string;
type Detail = { type: MediaType; id: number; preview?: Title | SavedTitle };
// El estado de navegación vive en el historial del navegador, así el botón «Atrás» del navegador funciona.
// `sub`: la pestaña se abrió encima de «Para ti» (hay una entrada de «Para ti» justo debajo en el historial).
type Nav = { profile: ProfileId | null; tab: Tab; detail: Detail | null; sub?: boolean };

/** Puente que expone la app de Android TV (MainActivity.java) para cerrar la app. */
type AndroidBridge = { exit?: () => void };
declare global {
  interface Window {
    QueVemosAndroid?: AndroidBridge;
    /** Lo llama la app de Android al pulsar Atrás en el mando. Devuelve true si la web lo ha gestionado. */
    __queVemosBack?: () => boolean;
  }
}
/** Tiempo para la segunda pulsación de Atrás que cierra la app. */
const EXIT_WINDOW_MS = 2200;

const HOME: Nav = { profile: null, tab: "foryou", detail: null };
const LAST_PROFILE = "quevemos:lastProfile";

// `short` e `icon` se usan en la barra inferior del móvil, donde no caben los nombres completos.
const TABS: { id: Tab; label: string; short: string; icon: string }[] = [
  { id: "foryou", label: "Para ti", short: "Para ti", icon: "🏠" },
  { id: "search", label: "Buscar", short: "Buscar", icon: "🔍" },
  { id: "surprise", label: "Sorpréndeme", short: "Sorpresa", icon: "🎲" },
  { id: "community", label: "Comunidad", short: "Gente", icon: "👥" },
  { id: "list", label: "Mi lista", short: "Lista", icon: "🔖" },
  { id: "seen", label: "Vistos", short: "Vistos", icon: "👁" },
  { id: "settings", label: "Ajustes", short: "Ajustes", icon: "⚙️" },
];

/**
 * Next.js recarga la página entera en un popstate si la entrada del historial no lleva su marca (`__NA` y su árbol).
 * Nuestras entradas copian esas claves de la actual para que Atrás del navegador no recargue la app.
 */
function historyState(n: Nav): Nav {
  const cur = history.state as Record<string, unknown> | null;
  const keep: Record<string, unknown> = {};
  if (cur) for (const k of ["__NA", "__PRIVATE_NEXTJS_INTERNALS_TREE"]) if (k in cur) keep[k] = cur[k];
  return { ...keep, ...n };
}

function readLastProfile() {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

type ProfilesRes = { profiles: PublicProfile[]; suggested: string | null; emojis: string[]; colors: string[] };

export default function App() {
  const [nav, setNav] = useState<Nav>(HOME);
  // Perfiles de la app, el propuesto para esta red y, si toca, el alta o el PIN que se está pidiendo.
  const [registry, setRegistry] = useState<ProfilesRes | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pinFor, setPinFor] = useState<PublicProfile | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ id: ProfileId; data: ProfileData } | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<Filters>(DEFAULT_FILTERS);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [redoQuiz, setRedoQuiz] = useState(false);
  const dirty = useRef(false);
  // Tarjeta que abrió la ficha, y su contenedor y posición por si desaparece mientras tanto (marcada como vista, descartada…).
  const openerRef = useRef<{ el: HTMLElement; group: Element | null; index: number } | null>(null);

  // ---------- Historial y botón Atrás ----------
  const navRef = useRef(nav);
  navRef.current = nav;
  const [exitHint, setExitHint] = useState(false);
  const exitArmedAt = useRef(0);

  /** Primera pulsación: aviso. Segunda (antes de ~2 s): cierra la app en la tele; en el navegador no hace nada. */
  const armExit = (): boolean => {
    const now = Date.now();
    if (now - exitArmedAt.current < EXIT_WINDOW_MS) {
      exitArmedAt.current = 0;
      setExitHint(false);
      return true;
    }
    exitArmedAt.current = now;
    setExitHint(true);
    return false;
  };
  useEffect(() => {
    if (!exitHint) return;
    const t = setTimeout(() => setExitHint(false), EXIT_WINDOW_MS);
    return () => clearTimeout(t);
  }, [exitHint]);

  useEffect(() => {
    setLastUsed(readLastProfile());
    const s = history.state as Nav | null;
    if (s && "tab" in s && (s.profile === null || typeof s.profile === "string")) setNav(s);
    else history.replaceState(historyState(HOME), "");
    const onPop = (e: PopStateEvent) => {
      const next = (e.state as Nav | null) ?? HOME;
      const prev = navRef.current;
      // Atrás del navegador (o de un APK antiguo) desde «Para ti» no saca del perfil a la primera: se avisa y se
      // restaura la entrada. El perfil solo se cambia con el botón del avatar.
      if (prev.profile && !next.profile && !prev.detail && !armExit()) {
        history.pushState(historyState(prev), "");
        return;
      }
      setNav(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const push = (next: Nav) => {
    history.pushState(historyState(next), "");
    setNav(next);
  };
  const replace = (next: Nav) => {
    history.replaceState(historyState(next), "");
    setNav(next);
  };

  /** Cambia de pestaña. Las pestañas se abren «encima» de Para ti, así Atrás del navegador también vuelve a ella. */
  const goTab = (tab: Tab) => {
    const cur = navRef.current;
    if (tab === cur.tab && !cur.detail) return;
    if (tab === "foryou") {
      if (cur.sub && !cur.detail) history.back();
      else replace({ ...cur, tab, detail: null, sub: false });
    } else if (cur.tab === "foryou" && !cur.detail) push({ ...cur, tab, detail: null, sub: true });
    else replace({ ...cur, tab, detail: null, sub: cur.sub });
  };

  // Atrás (mando, Escape o Retroceso): ficha → se cierra; otra pestaña → «Para ti»; «Para ti» → doble pulsación para salir.
  const back = () => {
    const cur = navRef.current;
    if (cur.detail) return history.back();
    if (cur.profile && cur.tab !== "foryou") {
      focusTabAfterNav.current = true;
      goTab("foryou");
      return;
    }
    if (armExit()) window.QueVemosAndroid?.exit?.();
  };
  // Tras volver a «Para ti» con Atrás (el cambio llega en un popstate asíncrono), el foco va a su pestaña.
  const focusTabAfterNav = useRef(false);
  useEffect(() => {
    if (!focusTabAfterNav.current || nav.tab !== "foryou") return;
    focusTabAfterNav.current = false;
    requestAnimationFrame(focusFirst);
  }, [nav.tab]);
  const backRef = useRef(back);
  backRef.current = back;
  const stableBack = useCallback(() => backRef.current(), []);
  useSpatialNav(stableBack);

  // La app de Android delega aquí su botón Atrás (ver MainActivity.java).
  useEffect(() => {
    window.__queVemosBack = () => {
      runBack(stableBack);
      return true;
    };
    return () => {
      delete window.__queVemosBack;
    };
  }, [stableBack]);

  // ---------- Datos ----------
  useEffect(() => {
    getJSON<Meta>("/api/meta").then(setMeta, (e) => setMetaError(e.message));
  }, []);

  const loadRegistry = useCallback(
    () =>
      getJSON<ProfilesRes>("/api/profiles").then(
        (r) => {
          setRegistry(r);
          return r;
        },
        (e) => {
          setRegistryError(e.message);
          return null;
        },
      ),
    [],
  );

  // Al arrancar: si esta tele ya entró en su último perfil (tiene su token), se abre directamente; si no, el
  // selector propone el último de la tele o el que más se usa desde esta red.
  useEffect(() => {
    loadRegistry().then((r) => {
      const s = history.state as Nav | null;
      if (!r || s?.profile) return;
      const last = readLastProfile();
      const p = r.profiles.find((x) => x.id === last);
      if (p && tokenOf(p.id)) enter(p.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (p: { id: ProfileId; data: ProfileData }) => {
    dirty.current = false;
    fetch(`/api/profile/${p.id}`, {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
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
    setActiveToken(tokenOf(id));
    getJSON<ProfileData>(`/api/profile/${id}`).then(
      (data) => {
        setProfile({ id, data });
        setFiltersState({ ...DEFAULT_FILTERS, ...data.lastFilters });
      },
      (e) => {
        // Token caducado (cambió el PIN) o de otro dispositivo: se vuelve a pedir el PIN.
        if (e instanceof HttpError && e.status === 401) {
          rememberToken(id, null);
          replace(HOME);
          const p = registry?.profiles.find((x) => x.id === id);
          if (p) setPinFor(p);
        } else setProfileError(e.message);
      },
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

  // Si la app se cierra o pasa a segundo plano antes de que venza el retardo, se guarda ya (keepalive).
  const profileRef = useRef(profile);
  profileRef.current = profile;
  useEffect(() => {
    const flush = () => {
      if (dirty.current && profileRef.current) save(profileRef.current);
    };
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback((fn: (d: ProfileData) => ProfileData) => {
    dirty.current = true;
    setProfile((p) => (p ? { ...p, data: fn(p.data) } : p));
  }, []);

  // Envía una señal al motor de recomendación. Las valoraciones solo se guardan por esta vía (el PUT del
  // perfil no las toca) y van en cola, una detrás de otra, para que el servidor nunca pierda ninguna.
  const feedbackQueue = useRef<Promise<unknown>>(Promise.resolve());
  const postFeedback = useCallback((body: object) => {
    const send = () =>
      fetch("/api/feedback", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body), keepalive: true }).catch(
        () => {},
      );
    feedbackQueue.current = feedbackQueue.current.then(send);
  }, []);
  const sendFeedback = useCallback(
    (id: ProfileId, t: Title | SavedTitle, body: { signal?: Signal | null; event?: ImplicitEvent }) => {
      const payload = { profile: id, key: titleKey(t), item: toSaved(t), ...body };
      // Los eventos implícitos no necesitan orden: salen al momento.
      if (body.event) fetch("/api/feedback", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(payload), keepalive: true }).catch(() => {});
      else postFeedback(payload);
    },
    [postFeedback],
  );

  const currentMeta = registry?.profiles.find((p) => p.id === nav.profile) ?? null;

  const api = useMemo<ProfileApi | null>(() => {
    if (!profile || !currentMeta || currentMeta.id !== profile.id) return null;
    const id = profile.id;
    const fb = profile.data.feedback ?? {};
    const track = (t: Title | SavedTitle, event: ImplicitEvent) => sendFeedback(id, t, { event });
    const seen = new Set(profile.data.seen);
    const listed = new Set(profile.data.watchlist.map(titleKey));
    return {
      id: profile.id,
      meta: currentMeta,
      plural: currentMeta.kind === "couple",
      data: profile.data,
      inList: (t) => listed.has(titleKey(t)),
      isSeen: (t) => seen.has(titleKey(t)),
      toggleList: (t) => {
        track(t, listed.has(titleKey(t)) ? "unwant" : "want");
        update((d) => {
          const k = titleKey(t);
          return d.watchlist.some((w) => titleKey(w) === k)
            ? { ...d, watchlist: d.watchlist.filter((w) => titleKey(w) !== k) }
            : { ...d, watchlist: [...d.watchlist, toSaved(t)] };
        });
      },
      toggleSeen: (t) => {
        track(t, seen.has(titleKey(t)) ? "unseen" : "seen");
        update((d) => {
          const k = titleKey(t);
          const seenAt = { ...(d.seenAt ?? {}) };
          if (d.seen.includes(k)) {
            delete seenAt[k];
            return { ...d, seen: d.seen.filter((s) => s !== k), seenAt };
          }
          seenAt[k] = Date.now();
          return { ...d, seen: [...d.seen, k], seenAt };
        });
      },
      setPlatforms: (platforms) => update((d) => ({ ...d, platforms })),
      clearSeen: () => update((d) => ({ ...d, seen: [], seenAt: {} })),
      setLastFilters: (lastFilters) => update((d) => ({ ...d, lastFilters })),
      feedbackOf: (t) => fb[titleKey(t)]?.s,
      rate: (t, signal) => {
        const k = titleKey(t);
        const next = signal && fb[k]?.s !== signal ? signal : null;
        sendFeedback(id, t, { signal: next });
        update((d) => {
          const feedback = { ...(d.feedback ?? {}) };
          if (next) feedback[k] = { s: next, t: Date.now() };
          else delete feedback[k];
          return { ...d, feedback };
        });
      },
      track,
    };
  }, [profile, currentMeta, update, sendFeedback]);

  const setFilters = (f: Filters) => {
    setFiltersState(f);
    api?.setLastFilters(f);
  };

  // ---------- Acciones ----------
  const enter = (id: ProfileId) => {
    try {
      localStorage.setItem(LAST_PROFILE, id);
    } catch {}
    setLastUsed(id);
    setRedoQuiz(false);
    setActiveToken(tokenOf(id));
    push({ profile: id, tab: "foryou", detail: null });
  };

  // Con token en esta tele se entra directamente; si no, se pide el PIN (o se crea, en perfiles antiguos sin PIN).
  const pickProfile = (p: PublicProfile) => (tokenOf(p.id) ? enter(p.id) : setPinFor(p));

  const login = async (p: PublicProfile, pin: string): Promise<string | null> => {
    try {
      const { token } = await sendJSON<{ token: string }>(`/api/profiles/${p.id}/session`, "POST", { pin });
      rememberToken(p.id, token);
      setPinFor(null);
      if (!p.hasPin) await loadRegistry();
      enter(p.id);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "No se ha podido entrar";
    }
  };

  const forgetDevice = () => {
    if (!nav.profile) return;
    rememberToken(nav.profile, null);
    setActiveToken(null);
    replace(HOME);
  };

  // Al terminar el cuestionario se guarda al momento: las recomendaciones las calcula el servidor con estos gustos.
  const finishQuiz = (prefs: Prefs, platforms: number[], ratings: QuizRatings) => {
    if (!profile) return;
    const f: Filters = { ...DEFAULT_FILTERS, type: prefs.types[0], onlyMine: platforms.length > 0 };
    const feedback = { ...(profile.data.feedback ?? {}) };
    const now = Date.now();
    for (const [k, r] of Object.entries(ratings)) feedback[k] = { s: r.signal, t: now };
    const next = { ...profile, data: { ...profile.data, prefs, platforms, lastFilters: f, feedback } };
    setProfile(next);
    save(next);
    // Las valoraciones del onboarding van al motor en un único lote para que entrene desde el primer momento.
    const batch = Object.entries(ratings).map(([key, r]) => ({ key, signal: r.signal }));
    if (batch.length) postFeedback({ profile: profile.id, batch });
    loadRegistry();
    setFiltersState(f);
    setRedoQuiz(false);
    replace({ ...nav, tab: "foryou", detail: null });
  };

  const openDetail = (t: Title | SavedTitle) => {
    const el = document.activeElement as HTMLElement | null;
    const group = el?.closest("[data-nav-group], .grid, .shelf-row") ?? null;
    openerRef.current = el ? { el, group, index: group ? focusables(group).indexOf(el) : -1 } : null;
    api?.track(t, "open");
    push({ ...nav, detail: { type: t.type, id: t.id, preview: t } });
  };

  // Al cerrar la ficha, el foco vuelve a la tarjeta que la abrió; si ya no está (se marcó como vista, se
  // descartó…), a la que ocupa ahora su lugar en la misma fila o rejilla, para no perder la posición.
  const hadDetail = useRef(false);
  useEffect(() => {
    if (hadDetail.current && !nav.detail) {
      const o = openerRef.current;
      requestAnimationFrame(() => {
        if (o && document.contains(o.el)) return focusEl(o.el);
        const items = o?.group && document.contains(o.group) ? focusables(o.group) : [];
        if (items.length && o) return focusEl(items[Math.min(Math.max(o.index, 0), items.length - 1)]);
        focusFirst();
      });
    }
    hadDetail.current = Boolean(nav.detail);
  }, [nav.detail]);

  // Al entrar en un perfil, foco en la primera pestaña.
  useEffect(() => {
    if (api && !nav.detail) requestAnimationFrame(focusFirst);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api?.id, redoQuiz, Boolean(api?.data.prefs)]);

  // ---------- Render ----------
  if (creating && registry) {
    return (
      <ProfileCreator
        profiles={registry.profiles}
        emojis={registry.emojis}
        colors={registry.colors}
        onCancel={() => setCreating(false)}
        onCreated={(p, token) => {
          rememberToken(p.id, token);
          setRegistry({ ...registry, profiles: [...registry.profiles, p] });
          setCreating(false);
          enter(p.id);
        }}
      />
    );
  }

  if (!nav.profile || !currentMeta) {
    return (
      <>
        <ProfilePicker profiles={registry?.profiles ?? null} focusId={lastUsed ?? registry?.suggested ?? null} onPick={pickProfile} onCreate={() => setCreating(true)} error={registryError} />
        {pinFor && (
          <PinPad
            key={pinFor.id}
            title={pinFor.hasPin ? `PIN de ${pinFor.name}` : `${pinFor.name}: crea tu PIN`}
            hint={pinFor.hasPin ? "Solo se pide la primera vez en esta tele." : "Este perfil aún no tiene PIN. Elige 4 cifras para protegerlo."}
            confirm={!pinFor.hasPin}
            onSubmit={(pin) => login(pinFor, pin)}
            onCancel={() => setPinFor(null)}
          />
        )}
        <ExitHint show={exitHint} />
      </>
    );
  }

  const current = currentMeta;
  const error = metaError ?? profileError;

  if (api && meta && (!api.data.prefs || redoQuiz)) {
    return (
      <Questionnaire
        key={`${api.id}:${redoQuiz}`}
        profileId={api.id}
        name={current.name}
        pareja={api.plural}
        meta={meta}
        initial={api.data.prefs}
        initialPlatforms={api.data.platforms}
        initialFeedback={api.data.feedback ?? {}}
        onDone={finishQuiz}
        onCancel={api.data.prefs ? () => setRedoQuiz(false) : undefined}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar" data-nav-header>
        <h1 className="logo">
          Qué <span>Vemos</span>
        </h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className="tab" aria-current={nav.tab === t.id ? "page" : undefined} data-autofocus={nav.tab === t.id || undefined} onClick={() => goTab(t.id)}>
              <span className="tab-icon" aria-hidden="true">
                {t.icon}
              </span>
              <span className="tab-label">{t.label}</span>
              <span className="tab-short" aria-hidden="true">
                {t.short}
              </span>
              {t.id === "list" && api && api.data.watchlist.length > 0 && <span className="tab-count">{api.data.watchlist.length}</span>}
            </button>
          ))}
        </nav>
        <button className="who" onClick={() => push(HOME)} title="Cambiar de perfil">
          <Avatar p={current} small />
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
            {nav.tab === "community" && <CommunityView onOpen={openDetail} />}
            {nav.tab === "list" && <ListView onOpen={openDetail} />}
            {nav.tab === "seen" && <SeenView meta={meta} onOpen={openDetail} />}
            {nav.tab === "settings" && <SettingsView meta={meta} onRedo={() => setRedoQuiz(true)} onForget={forgetDevice} />}
          </main>
          {nav.detail && <DetailModal key={`${nav.detail.type}:${nav.detail.id}`} target={nav.detail} onClose={stableBack} />}
        </ProfileContext.Provider>
      )}
      <ExitHint show={exitHint} />
    </div>
  );
}

function ExitHint({ show }: { show: boolean }) {
  return (
    <div className={`toast${show ? " toast--show" : ""}`} role="status" aria-live="polite">
      {show ? "Pulsa Atrás otra vez para salir" : ""}
    </div>
  );
}
