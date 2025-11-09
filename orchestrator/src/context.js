// src/context.js
let ctx = {
  patient: {
    name: "Alex",
    preferred_name: "Alex",
    favorites: { music: "Golden Oldies" }
  },
  caregiver: {
    name: "Dhinesh",
    status: "away_at_work",   // "away_at_work" | "with_patient" | "unavailable" | "unknown"
    return_info: "around 6 PM"         // e.g., "around 6 PM" or null if unknown
  }
};

export function getContext() { return ctx; }
export function updateContext(patch = {}) {
  ctx = {
    ...ctx,
    ...patch,
    patient:   { ...ctx.patient,   ...(patch.patient   || {}) },
    caregiver: { ...ctx.caregiver, ...(patch.caregiver || {}) }
  };
  return ctx;
}
