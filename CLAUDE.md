# Qué Vemos: notas para Claude Code

App Next.js 16 (App Router, TypeScript, CSS sin frameworks) para elegir peli o serie desde la tele con el mando. El usuario es Víctor; la app la usan Víctor y Alba. Escribe la UI y los textos en español de España.

## Antes de tocar Next.js
Esta versión de Next tiene cambios incompatibles con versiones antiguas: consulta `node_modules/next/dist/docs/` antes de usar una API que no veas ya en el código (por ejemplo, `params` en rutas es una Promise y se usa `RouteContext<"/ruta">`).

## Comandos
- `npm run dev` arranca en local (http://localhost:3000). Necesita `.env.local` con `TMDB_API_KEY`.
- `npm run build` compila y comprueba tipos. Ejecútalo siempre antes de hacer commit.

## Despliegue
- El repo está en GitHub (`victorodri/que-vemos-tv`) y conectado a Vercel: **cada push a `main` despliega producción**. Para «actualizar la app» basta con commit + push, después de que el build pase.
- Las ramas distintas de `main` generan una URL de preview en Vercel; úsalas para cambios grandes.
- Variables de entorno (en Vercel → Settings → Environment Variables, y en `.env.local` en local):
  - `TMDB_API_KEY`: API key v3 o token v4 de TMDB. **Nunca la escribas en el código ni la subas al repo.**
  - `KV_REST_API_URL` y `KV_REST_API_TOKEN`: Upstash Redis, los pone Vercel al conectar la base de datos.

## Arquitectura
- El cliente nunca llama a TMDB directamente: todo pasa por `src/app/api/*` → `src/lib/tmdb.ts` (región `ES`, idioma `es-ES`, respuestas cacheadas con `next.revalidate`).
- `discover` solo devuelve títulos con streaming en España (`with_watch_monetization_types=flatrate|free|ads`).
- Perfiles: `src/config/profiles.ts`. Los datos de cada perfil (`ProfileData` en `src/lib/types.ts`) se guardan como un JSON en Redis con la clave `quevemos:profile:<id>`. El cliente guarda el objeto entero con `PUT /api/profile/<id>`, con un retardo de 600 ms.
- Navegación con mando: `src/components/spatialNav.ts`. Todo lo interactivo tiene que ser `<button>`, `<input>` o `<a href>` para que las flechas lo encuentren. Lo que tenga `data-autofocus` recibe el foco al abrir una vista; un contenedor con `data-nav-modal` limita la navegación a su interior.
- El estado de navegación (perfil, pestaña, ficha abierta) vive en `history.state`, así el botón Atrás del mando funciona.

## Cuestionario y recomendaciones
- `src/lib/prefs.ts`: preguntas → `Prefs` (en `ProfileData.prefs`) y `prefsToDiscover`, que traduce gustos a parámetros de discover. Los géneros del cuestionario son grupos con IDs distintos para pelis y series.
- `discover` en `src/lib/tmdb.ts` aplica los gustos solo cuando `filters.taste` está activo y el filtro correspondiente está en «Cualquiera»: lo que elige el usuario a mano siempre manda.
- Si un perfil no tiene `prefs`, `App.tsx` muestra `Questionnaire.tsx` antes que nada.

## Motor de recomendación (`src/lib/reco/`) — la parte más importante
Lee primero `src/lib/reco/types.ts`: describe el diseño y el contrato de las APIs.
- `features.ts`: «ADN» de cada título (vector disperso: `g:` género, `k:` palabra clave, `c:` dirección/creación, `p:` reparto, `d:` década, `l:` idioma, `t:` tipo, `r:` duración) + títulos relacionados. Se cachea 30 días en Redis (`item:v<N>:`); sube `VERSION` si cambias cómo se construye.
- `model.ts`: vector de gustos por perfil. Cada señal suma los rasgos del título con un peso (`SIGNAL_WEIGHT`) y olvido de 180 días; el cuestionario es un prior que se diluye con las señales. `buildTaste` es puro; `trainTaste`/`retrain` guardan en `taste:<id>`. La pareja = su vector + el mínimo por rasgo de Víctor y Alba (lo que gusta a los dos) y bloquea lo que cualquiera rechazó. Sube `MODEL_VERSION` si cambia el formato.
- `engine.ts`: recuperación (fuentes: «porque te gustó» con el grafo de TMDB, géneros, temas, joyas maduras, tendencias, novedades, personas) → criba ligera → rasgos completos + disponibilidad en España → puntuación (`TUNING`) → MMR → explicación. `recommend()` es puro; `getShelves()` monta las estanterías y las cachea 15 min por hash del modelo. `pickWeighted()` es el Sorpréndeme ponderado y `getSeeds()` las semillas del onboarding.
- `learner.ts`: regresión logística dispersa con AdaGrad + L2 (positivos, negativos y títulos conocidos sin interacción como negativos de baja confianza). `model.affinity()` mezcla Rocchio y regresión (la regresión pesa hasta un 50 % según el nº de ejemplos): úsala siempre en vez de `cosine` para puntuar.
- Pareja: afinidad de grupo por título («media sin miseria»: media + mínimo de los dos + su vector propio). Lista principal calibrada por géneros (Steck 2018, `TUNING.calibration`).
- `surprise.ts`: Sorpréndeme infinito. Bandido con muestreo de Thompson sobre 6 fuentes (`taste`, `related`, `explore`, `gems`, `fresh`, `trending`) que aprende de cada reacción (`learnFromReaction`, llamado desde /api/feedback), memoria de lo propuesto 21 días (`shown:<id>`), páginas profundas y órdenes al azar, temperatura que sube con los saltos seguidos (`streak:<id>`). La API devuelve lotes y el cliente mantiene una cola precargada.
- Valoraciones: SOLO se escriben por `POST /api/feedback` (clave propia `feedback:<id>`, también en lote con `batch`). El `PUT` del perfil nunca las toca: así no se pisan entre dispositivos. El cliente las encola en orden.
- Eventos implícitos (`open`, `skip`, `want`, `seen`…) van a `events:<id>` (últimos 2000), con antirrebote de 60 s.
- `/api/cron/refresh` (Vercel Cron diario, protegido con `CRON_SECRET`) reentrena los tres perfiles.
- Evaluación offline: `scripts/eval-reco.ts` simula usuarios con gustos ocultos y mide precisión, NDCG, diversidad y novedad. Úsala antes y después de tocar pesos (`TUNING`, `SIGNAL_WEIGHT`, `FAMILY_WEIGHT`) y deja los números en el commit.

## Vistos
- `ProfileData.seenAt` guarda cuándo se marcó cada visto; el `PUT` del perfil lo valida y conserva fechas que el cliente no envíe. Los vistos antiguos sin fecha toman la del último evento `seen` o salen en «Sin fecha».
- `GET /api/seen?profile=<id>` resuelve los títulos (más recientes primero) para `SeenView.tsx` (pestaña «Vistos», filtros por tipo y género).

## Agentes especializados (`.claude/agents/`)
- `algoritmo-reco`: audita y mejora el motor (`src/lib/reco/**`) con datos reales en solo lectura y la evaluación offline (`--engine head` compara con el commit anterior).
- `ux-tv`: audita y mejora la interfaz con el mando (componentes, CSS, navegación espacial).
- Cada uno tiene archivos propios para poder trabajar en paralelo; ninguno escribe en producción.

## App Android TV (`android/`)
- WebView que carga `BuildConfig.APP_URL`; no contiene lógica de la app. Los cambios de la web **no** requieren nuevo APK.
- Solo hace falta tocar `android/` para cambiar icono, nombre, URL o el comportamiento del mando. Al hacer push con cambios ahí, GitHub Actions compila y publica una release `apk-vN` (descarga: `/apk` en la web).
- No hay Android SDK ni Java en el Mac: no intentes compilar en local, usa el workflow (`gh workflow run android.yml`, `gh run watch`).
- La clave de firma está en `~/.config/que-vemos-tv/` (fuera del repo) y en los secretos del repo. Nunca la subas al repo.

## Diseño
Interfaz «10 pies»: textos grandes (rem, con escala por `vw` en `html`), tema oscuro y foco muy visible (anillo amarillo + escala). Respeta los márgenes `--safe-x` / `--safe-y` (overscan de la tele). Comprueba los cambios de UI con el teclado (flechas + Enter + Escape) y en móvil.
