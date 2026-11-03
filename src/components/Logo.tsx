/** Logo de QuéVer: «play» con la tilde de «Qué» + nombre. El mismo símbolo que los iconos (scripts/brand.mjs). */
export function Logo({ big = false }: { big?: boolean }) {
  return (
    <h1 className={big ? "logo logo--big" : "logo"} aria-label="QuéVer">
      <svg className="logo-mark" viewBox="20 2 62 86" aria-hidden="true">
        <path d="M34 30 L34 78 L74 54 Z" fill="currentColor" stroke="currentColor" strokeWidth="12" strokeLinejoin="round" />
        <path d="M53 20 L65 9" stroke="currentColor" strokeWidth="8" strokeLinecap="round" />
      </svg>
      <span className="logo-word" aria-hidden="true">
        Qué<span>Ver</span>
      </span>
    </h1>
  );
}
