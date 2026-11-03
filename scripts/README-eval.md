# Evaluación offline del recomendador

Simula personas con gustos ocultos (`scripts/personas.mts`), les hace el onboarding (valoran las semillas),
y repite rondas de «recomendar → valorar las 10 primeras → reentrenar». Mide precisión, nDCG, diversidad,
joyas, explicaciones y latencia, y compara con una línea base genérica (motor sin cuestionario ni valoraciones).

```bash
QUEVEMOS_STORE_FILE=.data/eval-store.json npx tsx --conditions=react-server --env-file=.env.local \
  scripts/eval-reco.mts --rounds 3 --couple avgMisery --variants current,combo,mmr60 [--seed 11] [--engine quota --quota 0.4] [--quick]
```

- `QUEVEMOS_STORE_FILE` es obligatorio: usa su propio almacén y no toca los perfiles del servidor.
- Caché HTTP de TMDB en `.data/eval-http-cache.json` (la primera ejecución hace ~1000 llamadas; las siguientes casi ninguna).
- Resultados por variante en `.data/eval-results.json`; tablas en la salida estándar.
- `--variants`: nombres definidos en `VARIANTS` (mutan `TUNING` / `SIGNAL_WEIGHT` en caliente) o `all`.
- `--couple avgMisery`: emula la combinación propuesta para el perfil pareja (recuperación con la media de los dos,
  ranking «media sin miseria» por título). `current` usa el motor tal cual.
- `--engine quota`: usa `scripts/variants/engine-quota.ts`, copia del motor con cuota por fuente en la criba
  (hay que regenerarla si cambia `src/lib/reco/engine.ts`).
- Con gustos tan opuestos, el acierto de pareja es «los dos contentos»: min(uA, uB) ≥ 0,5.
- `--engine head`: usa `scripts/variants/engine-head.ts`, copia del motor del commit 41121eb, para comparar antes/después
  en las mismas condiciones. Ejecuta las semillas en serie, no en paralelo: con varios procesos TMDB responde 429
  y las listas vacías falsean el resultado.
