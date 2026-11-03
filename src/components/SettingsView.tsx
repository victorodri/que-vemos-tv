"use client";
import { useState } from "react";
import type { Meta } from "@/lib/types";
import { useProfile } from "./profileContext";

export function SettingsView({ meta, onRedo, onForget }: { meta: Meta; onRedo: () => void; onForget: () => void }) {
  const profile = useProfile();
  const { platforms, seen } = profile.data;
  const [confirmClear, setConfirmClear] = useState(false);

  const toggle = (id: number) => profile.setPlatforms(platforms.includes(id) ? platforms.filter((p) => p !== id) : [...platforms, id]);

  return (
    <div className="view">
      <h2>Mis plataformas</h2>
      <p className="hint">Marca las que tenéis contratadas y usa el filtro «Solo las mías».</p>
      <div className="platforms">
        {meta.providers.map((p, i) => (
          <button key={p.id} className="platform" aria-pressed={platforms.includes(p.id)} onClick={() => toggle(p.id)} data-autofocus={i === 0 || undefined}>
            {p.logo && <img src={p.logo} alt="" />}
            <span>{p.name}</span>
          </button>
        ))}
      </div>

      <h2>Gustos</h2>
      <p className="hint">Las recomendaciones de «Para ti» y «Sorpréndeme» salen del cuestionario inicial.</p>
      <div>
        <button className="btn" onClick={onRedo}>
          ✎ Repetir cuestionario
        </button>
      </div>

      <h2>Historial</h2>
      <p className="hint">
        {seen.length} título{seen.length === 1 ? "" : "s"} marcado{seen.length === 1 ? "" : "s"} como visto. «Sorpréndeme» nunca los propone.
      </p>
      {seen.length > 0 && (
        <button
          className="btn"
          onClick={() => {
            if (!confirmClear) return setConfirmClear(true);
            profile.clearSeen();
            setConfirmClear(false);
          }}
          onBlur={() => setConfirmClear(false)}
        >
          {confirmClear ? "Pulsa otra vez para borrar el historial" : "Borrar historial de vistas"}
        </button>
      )}

      <h2>Perfil</h2>
      <p className="hint">
        {profile.meta.emoji} {profile.meta.name} · {profile.plural ? "perfil en pareja" : "perfil individual"}. Los demás perfiles de Qué Vemos solo ven tu nombre y lo que te
        encantó.
      </p>
      <div>
        <button className="btn" onClick={onForget}>
          🔒 Cerrar sesión en esta tele
        </button>
      </div>

      {meta.storage === "local" && (
        <p className="hint warn">
          Aviso: no hay base de datos conectada, los perfiles se guardan de forma temporal. Conecta Upstash Redis en Vercel (ver README).
        </p>
      )}
    </div>
  );
}
