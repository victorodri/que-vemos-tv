// Perfiles de la app. Para añadir o renombrar uno basta con editar esta lista:
// el `id` es la clave con la que se guardan sus datos, así que no lo cambies
// si no quieres empezar ese perfil de cero.
export const PROFILES = [
  { id: "victor", name: "Víctor", initials: "V", color: "#4f8cff" },
  { id: "pareja", name: "Víctor + Alba", initials: "V+A", color: "#ff5c8a" },
  { id: "alba", name: "Alba", initials: "A", color: "#ffb547" },
] as const;

export type ProfileId = (typeof PROFILES)[number]["id"];

export const isProfileId = (id: string): id is ProfileId => PROFILES.some((p) => p.id === id);
