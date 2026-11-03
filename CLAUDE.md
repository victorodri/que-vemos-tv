# QuéVer (antes «Qué Vemos»): notas para Claude Code

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
  - `SESSION_SECRET` (opcional): firma los tokens de perfil; sin ella se deriva de `CRON_SECRET`/`TMDB_API_KEY`.
  - `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` y `OMDB_API_KEY` (opcionales): activan Reddit y las notas de Rotten Tomatoes/Metacritic/IMDb.

## Arquitectura
- El cliente nunca llama a TMDB directamente: todo pasa por `src/app/api/*` → `src/lib/tmdb.ts` (región `ES`, idioma `es-ES`, respuestas cacheadas con `next.revalidate`).
- `discover` solo devuelve títulos con streaming en España (`with_watch_monetization_types=flatrate|free|ads`).
- Perfiles: se crean desde la app (`src/lib/profiles.ts`, registro en `profiles:index`). Individuales o en pareja (una pareja puede enlazar dos perfiles individuales en `members`). Cada uno tiene PIN de 4 cifras (scrypt + sal, bloqueo tras 8 fallos); al entrar el servidor da un token HMAC que la tele guarda en `localStorage` (`quevemos:tokens`) y que va en la cabecera `x-profile-token`. Todas las rutas con `profile` usan `authorize()`. Un perfil antiguo sin PIN (Víctor) lo crea al entrar.
- Perfil por defecto: al arrancar, si la tele tiene token de su último perfil entra directamente; si no, el selector enfoca el último de la tele o el más reciente de esa red (`ipmap:<HMAC de la IP>`, nunca la IP en claro).
- Los datos de cada perfil (`ProfileData` en `src/lib/types.ts`) se guardan como un JSON en Redis con la clave `quevemos:profile:<id>`. El cliente guarda el objeto entero con `PUT /api/profile/<id>`, con un retardo de 600 ms.
- Navegación con mando: `src/components/spatialNav.ts`. Todo lo interactivo tiene que ser `<button>`, `<input>` o `<a href>` para que las flechas lo encuentren. Lo que tenga `data-autofocus` recibe el foco al abrir una vista; un contenedor con `data-nav-modal` limita la navegación a su interior.
- El estado de navegación (perfil, pestaña, ficha abierta) vive en `history.state`, así el botón Atrás del mando funciona.

## Cuestionario y recomendaciones
- `src/lib/prefs.ts`: preguntas → `Prefs` (en `ProfileData.prefs`) y `prefsToDiscover`, que traduce gustos a parámetros de discover. Los géneros del cuestionario son grupos con IDs distintos para pelis y series.
- `discover` en `src/lib/tmdb.ts` aplica los gustos solo cuando `filters.taste` está activo y el filtro correspondiente está en «Cualquiera»: lo que elige el usuario a mano siempre manda.
- Si un perfil no tiene `prefs`, `App.tsx` muestra `Questionnaire.tsx` antes que nada.

## Motor de recomendación (`src/lib/reco/`) — la parte más importante
Lee primero `src/lib/reco/types.ts`: describe el diseño y el contrato de las APIs.
- `features.ts`: «ADN» de cada título (vector disperso: `g:` género, `k:` palabra clave, `c:` dirección/creación, `p:` reparto, `d:` década, `l:` idioma, `t:` tipo, `r:` duración) + títulos relacionados. Se cachea 30 días en Redis (`item:v<N>:`); sube `VERSION` si cambias cómo se construye.
- `model.ts`: vector de gustos por perfil. Cada señal suma los rasgos del título con un peso (`SIGNAL_WEIGHT`) y olvido de 180 días; el cuestionario es un prior que se diluye con las señales. `buildTaste` es puro; `trainTaste`/`retrain` guardan en `taste:<id>`. Una pareja con miembros enlazados = media de sus vectores + su vector propio, y bloquea lo que cualquiera rechazó. Sube `MODEL_VERSION` si cambia el formato.
- `engine.ts`: recuperación (fuentes: «porque te gustó» con el grafo de TMDB, géneros, temas, joyas maduras, tendencias, novedades, personas) → criba ligera → rasgos completos + disponibilidad en España → puntuación (`TUNING`) → MMR → explicación. `recommend()` es puro; `getShelves()` monta las estanterías y las cachea 15 min por hash del modelo. `pickWeighted()` es el Sorpréndeme ponderado y `getSeeds()` las semillas del onboarding.
- `learner.ts`: regresión logística dispersa con AdaGrad + L2 (positivos, negativos y títulos conocidos sin interacción como negativos de baja confianza). `model.affinity()` mezcla Rocchio y regresión (la regresión pesa hasta un 50 % según el nº de ejemplos): úsala siempre en vez de `cosine` para puntuar.
- Pareja: afinidad de grupo por título («media sin miseria»: media + mínimo de los dos + su vector propio). Lista principal calibrada por géneros (Steck 2018, `TUNING.calibration`).
- `surprise.ts`: Sorpréndeme infinito. Bandido con muestreo de Thompson sobre 6 fuentes (`taste`, `related`, `explore`, `gems`, `fresh`, `trending`) que aprende de cada reacción (`learnFromReaction`, llamado desde /api/feedback), memoria de lo propuesto 21 días (`shown:<id>`), páginas profundas y órdenes al azar, temperatura que sube con los saltos seguidos (`streak:<id>`). La API devuelve lotes y el cliente mantiene una cola precargada.
- Valoraciones: SOLO se escriben por `POST /api/feedback` (clave propia `feedback:<id>`, también en lote con `batch`). El `PUT` del perfil nunca las toca: así no se pisan entre dispositivos. El cliente las encola en orden.
- Eventos implícitos (`open`, `skip`, `want`, `seen`…) van a `events:<id>` (últimos 2000), con antirrebote de 60 s.
- `/api/cron/refresh` (Vercel Cron diario, protegido con `CRON_SECRET`): lee los RSS de crítica, calcula las críticas de lo valorado y reentrena todos los perfiles (individuales primero, luego parejas).
- Comunidad (`community.ts`): filtrado colaborativo usuario-usuario. Similitud = coseno de los vectores de gustos + coincidencias en «me encanta». Lo que les encantó a los parecidos entra como fuente `community` y como estantería «A perfiles como el tuyo les encantó»; `/api/community` alimenta la pestaña Comunidad (solo nombre, avatar y lo que les gustó).
- Críticas (`src/lib/reviews/`): TMDB (reseñas), Wikipedia (sección de recepción vía Wikidata), blogs y medios por RSS (`rss.ts`, el cron los indexa por título y la hemeroteca crece), Reddit y OMDb si hay claves. Análisis por reglas (`text.ts`: tono con léxico ES/EN y aspectos como «tensa», «giros», «lenta»). Resultado: nota de la crítica (entra en la calidad con `TUNING.wCritic`) y aspectos como rasgos `a:` del título (se añaden en `getManyFeatures`). Las preguntas de «forma de ser» del cuestionario (`PERSONA_QUESTIONS` en `prefs.ts`) son un prior sobre esos aspectos. La ficha muestra «Qué dice la crítica» (`/api/reviews/<tipo>/<id>`). Solo se guardan fragmentos cortos con enlace.
- Evaluación offline: `scripts/eval-reco.ts` simula usuarios con gustos ocultos y mide precisión, NDCG, diversidad y novedad. Úsala antes y después de tocar pesos (`TUNING`, `SIGNAL_WEIGHT`, `FAMILY_WEIGHT`) y deja los números en el commit.

## Interacción, rotación, encuestas e insights (`src/lib/reco/engagement.ts`)
- Objetivo de negocio: que encuentre algo y lo guarde en su lista cuanto antes. Métricas por sesión (`SessionStat`): aperturas de ficha, añadidos, tiempo hasta la primera ficha y hasta el primer añadido.
- Sesión = una apertura de la app (`src/lib/engage.ts` en el cliente; 30 min sin actividad = sesión nueva, y «Para ti» se renueva sola). El cliente envía en lotes a `POST /api/engage` las tiras que entran en pantalla (con sus títulos visibles) y las acciones con su origen (tira o pestaña).
- Estado por perfil en `engage:v1:<id>`: uso de cada tira (vistas, sesiones en que abrió algo, añadidos, racha sin tocarla, con olvido de 14 días), impresiones por título (cansancio), últimas portadas, sesiones, insights, encuestas e intención del día.
- `getShelves()` devuelve más candidatos (32 en «Lo mejor», hasta 5 «Porque te gustó…» y 3 «Más de…», 24 por tira) y `/api/reco?session=` aplica `arrangeShelves()`: «Lo mejor» primero con una portada que no repite las 8 últimas, tiras ordenadas por muestreo de Thompson sobre su tasa de uso, más títulos en las que usa y menos en las que no, fuera los títulos vistos pasar ~4 veces sin abrir, y retiradas 21 días las tiras ignoradas 5 sesiones seguidas (con un insight). Con casi todo retirado, vuelven las que llevan más tiempo fuera.
- Micro-encuestas (`nextSurvey`, `GET/POST /api/survey`, `SurveyCard.tsx`): nunca en la primera sesión, como mucho una cada 2 sesiones y 30 h. Prioridad: tira dudosa (3 sesiones sin tocarla) → «¿Qué te apetece hoy?» tras 2 sesiones sin guardar nada (crea la tira «Para hoy: …» 12 h) → nota de un visto sin valorar → «¿Te ayudan las recomendaciones?».
- Insights del perfil (`src/lib/reco/insights.ts`, `GET /api/insights`, `InsightsView.tsx` en la pestaña «Mi perfil»): conclusiones en frases, rasgos por familia del vector de gustos, lo que evita, uso de las tiras, métricas clave y registro de conclusiones.
- `scripts/sim-engage.mts` simula varias aperturas sin red para comprobar la rotación, las retiradas y las encuestas.

## Social y novedades
- `src/lib/activity.ts` + `/api/activity`: actividad real y positiva de otros perfiles (❤️, 👍, vistas, lista) para la franja «En Qué Vemos», los contadores 👥 de las tarjetas y el feed de Comunidad. Nunca se inventa actividad.
- `src/lib/buzz.ts` + `/api/buzz`: «Estrenos que están dando que hablar» (cines ES, plataformas, series nuevas en tendencia), ordenados por tendencia, popularidad, votos recientes y crítica; personalizado con la afinidad del perfil. Caché 3 h.

## Mando, sonido y Atrás
- Atrás: ficha → se cierra; otra pestaña → «Para ti»; «Para ti» → aviso y, con una segunda pulsación, cierra la app (`window.QueVemosAndroid.exit()`, puente del APK ≥ 1.1). El APK delega Atrás en `window.__queVemosBack()`. Cambiar de perfil solo desde el avatar.
- `src/lib/sound.ts`: sonidos sutiles con Web Audio al mover el foco y al pulsar OK (desactivables en Ajustes). `HeartBurst.ts`: explosión de corazones al marcar «Me encanta».
- Las entradas de historial copian las claves internas de Next (`historyState()` en App.tsx); sin ellas, Atrás recarga la página.

## Vistos
- `ProfileData.seenAt` guarda cuándo se marcó cada visto; el `PUT` del perfil lo valida y conserva fechas que el cliente no envíe. Los vistos antiguos sin fecha toman la del último evento `seen` o salen en «Sin fecha».
- `GET /api/seen?profile=<id>` resuelve los títulos (más recientes primero) para `SeenView.tsx` (pestaña «Vistos», filtros por tipo y género).

## Agentes especializados (`.claude/agents/`)
- `algoritmo-reco`: audita y mejora el motor (`src/lib/reco/**`) con datos reales en solo lectura y la evaluación offline (`--engine head` compara con el commit anterior).
- `ux-tv`: audita y mejora la interfaz con el mando (componentes, CSS, navegación espacial).
- Cada uno tiene archivos propios para poder trabajar en paralelo; ninguno escribe en producción.

## App Android TV (`android/`)
- WebView que carga `BuildConfig.APP_URL`; no contiene lógica de la app. Los cambios de la web **no** requieren nuevo APK.
- Solo hace falta tocar `android/` para cambiar icono, nombre, URL o el comportamiento del mando.
- Logo, favicon, iconos del launcher y banner de la tele (320×180, 480×270 y 640×360) salen de `scripts/brand.mjs` (`node scripts/brand.mjs`, en el Mac). El banner va en `<application>` y en la actividad: Fire TV lo lee de la actividad. Al hacer push con cambios ahí, GitHub Actions compila y publica una release `apk-vN` (descarga: `/apk` en la web).
- No hay Android SDK ni Java en el Mac: no intentes compilar en local, usa el workflow (`gh workflow run android.yml`, `gh run watch`).
- La clave de firma está en `~/.config/que-vemos-tv/` (fuera del repo) y en los secretos del repo. Nunca la subas al repo.

## Diseño
Interfaz «10 pies»: textos grandes (rem, con escala por `vw` en `html`), tema oscuro y foco muy visible (anillo amarillo + escala). Respeta los márgenes `--safe-x` / `--safe-y` (overscan de la tele). Comprueba los cambios de UI con el teclado (flechas + Enter + Escape) y en móvil.
