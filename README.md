# Qué Vemos 🍿

App para decidir en pareja qué peli o serie ver, pensada para usarse en la tele (Fire TV / Android TV) con el mando: flechas para moverse, OK para elegir y Atrás para volver. La web vive en Vercel y en la tele se instala como APK (que carga esa web, así que se actualiza sola).

- **Cuestionario inicial**: la primera vez que entra cada perfil responde 8 preguntas (pelis o series, géneros favoritos y vetados, duración, época, exigencia, éxitos o joyas ocultas y plataformas). Con eso se calculan las recomendaciones de «Para ti» y «Sorpréndeme». Se puede repetir desde Ajustes.
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

## App para la tele (APK)

`android/` es una app Android TV mínima (Java, sin dependencias): una WebView a pantalla completa que carga la web de Vercel, con icono y banner para el menú de la Fire TV. Como el contenido viene de Vercel, **no hace falta reinstalarla al cambiar la web**.

- GitHub Actions la compila (`.github/workflows/android.yml`) cada vez que cambia algo en `android/`, o a mano desde la pestaña Actions → «APK Android TV» → Run workflow.
- La URL que carga sale de la variable de repo `APP_URL` (por defecto `https://que-vemos-tv.vercel.app`).
- Descarga: `https://<tu-app>.vercel.app/apk` (redirige a la última release de GitHub).
- Firma: secretos `ANDROID_KEYSTORE_BASE64` y `ANDROID_KEYSTORE_PASSWORD`. La clave original está en `~/.config/que-vemos-tv/` del Mac de Víctor: **guárdala con copia de seguridad**, sin ella no se puede actualizar el APK encima del instalado.

### Instalar en la Fire TV
1. Ajustes → Mi Fire TV → Opciones para desarrolladores → **Instalar apps desconocidas** → activar para *Downloader*. (Si no ves «Opciones para desarrolladores»: Ajustes → Mi Fire TV → Información → pulsa 7 veces sobre el nombre del dispositivo.)
2. Instala **Downloader** (de AFTVnews) desde la tienda de Amazon.
3. En Downloader escribe `https://<tu-app>.vercel.app/apk` → Instalar.
4. «Qué Vemos» aparece en *Tus apps*; muévela a la fila principal.

## Estructura

| Ruta | Qué hace |
| --- | --- |
| `src/config/profiles.ts` | Lista de perfiles (nombre, iniciales, color) |
| `src/lib/tmdb.ts` | Llamadas a TMDB (discover, search, detalle, watch/providers, región ES) |
| `src/lib/store.ts` | Guardado de perfiles en Upstash Redis o en un archivo local |
| `src/app/api/*` | API interna: la API key solo vive en el servidor |
| `src/components/spatialNav.ts` | Navegación con las flechas del mando |
| `src/components/*View.tsx` | Pantallas: Buscar, Sorpréndeme, Mi lista, Plataformas |
