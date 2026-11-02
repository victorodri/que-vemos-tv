import type { Provider } from "@/lib/types";

export function ProviderList({
  providers,
  rentOrBuy,
  withNames = false,
  max = 6,
}: {
  providers?: Provider[];
  rentOrBuy?: boolean;
  withNames?: boolean;
  max?: number;
}) {
  if (!providers) return null;
  if (!providers.length) {
    return <p className="providers-empty">{rentOrBuy ? "Solo alquiler o compra" : "No está en streaming en España"}</p>;
  }
  const shown = providers.slice(0, max);
  return (
    <ul className={`providers${withNames ? " providers--named" : ""}`}>
      {shown.map((p) => (
        <li key={p.id} title={p.name}>
          {p.logo ? <img src={p.logo} alt={p.name} loading="lazy" /> : <span className="provider-fallback">{p.name}</span>}
          {withNames && p.logo && <span>{p.name}</span>}
        </li>
      ))}
      {providers.length > max && <li className="providers-more">+{providers.length - max}</li>}
    </ul>
  );
}
