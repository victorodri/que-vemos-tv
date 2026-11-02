# Qué Vemos 🍿

App web para decidir en pareja qué peli o serie ver, pensada para usarse en la tele (Fire TV / Android TV) con el mando: flechas para moverse, OK para elegir y Atrás para volver.

- **Perfiles**: Víctor, Víctor + Alba y Alba. Cada uno tiene su lista «Quiero verla», sus vistas, sus plataformas y sus últimos filtros.
- **Buscar**: por texto o con filtros (tipo, género, duración máxima, nota mínima, año y «solo mis plataformas»).
- **Sorpréndeme**: propone un título al azar con los filtros puestos, sin repetir los ya vistos. «Otra» propone otro.
- **Dónde verla**: plataformas de streaming en España (Netflix, Max, Disney+, Prime Video…) según TMDB / JustWatch.

Datos de [TMDB](https://www.themoviedb.org/). Este producto usa la API de TMDB pero TMDB no lo respalda ni lo certifica.

## Arrancar en local

```bash
npm install
cp .env.example .env.local   # y pon tu TMDB_API_KEY
npm run dev                  # http://localhost:3000
```

Sin las variables de Redis, en local los perfiles se guardan en `.data/store.json`.

## Desplegar en Vercel (gratis)

1. En [vercel.com/new](https://vercel.com/new) importa el repositorio de GitHub `victorodri/que-vemos-tv` (framework: Next.js, sin cambiar nada).
2. **Settings → Environment Variables**: añade `TMDB_API_KEY` (Production, Preview y Development).
3. **Storage → Create Database → Upstash (Redis)** → plan gratuito → conéctala al proyecto. Vercel añade solo `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
4. **Deployments → Redeploy** para que coja las variables.

A partir de ahí, cada `git push` a `main` se publica solo en 1–2 minutos.

## En la tele (Fire TV)

Abre la URL de Vercel en Silk (o en un navegador como TV Bro) y añádela a favoritos. El mando funciona tal cual: flechas, OK y Atrás.

## Estructura

| Ruta | Qué hace |
| --- | --- |
| `src/config/profiles.ts` | Lista de perfiles (nombre, iniciales, color) |
| `src/lib/tmdb.ts` | Llamadas a TMDB (discover, search, detalle, watch/providers, región ES) |
| `src/lib/store.ts` | Guardado de perfiles en Upstash Redis o en un archivo local |
| `src/app/api/*` | API interna: la API key solo vive en el servidor |
| `src/components/spatialNav.ts` | Navegación con las flechas del mando |
| `src/components/*View.tsx` | Pantallas: Buscar, Sorpréndeme, Mi lista, Plataformas |
