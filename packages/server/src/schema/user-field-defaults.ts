/**
 * Opinionated defaults for user field display and filterability.
 *
 * These are merged over discovered fields at schema creation time.
 * Fields not listed here default to { display: true, filterable: true }.
 *
 * Operators can override these through update_user_field_schema after
 * the schema is created.
 */

export interface FieldDefaults {
  display: boolean;
  filterable: boolean;
  displayOrder?: number;
}

export const USER_FIELD_DEFAULTS: Record<string, FieldDefaults> = {
  // ── Identity ──────────────────────────────────────────────────────────
  id:             { display: true,  filterable: true,  displayOrder: 10 },
  username:       { display: true,  filterable: true,  displayOrder: 25 },
  idnumber:       { display: false, filterable: true },

  // ── Name ──────────────────────────────────────────────────────────────
  firstname:      { display: false, filterable: true },
  lastname:       { display: false, filterable: true },
  fullname:       { display: true,  filterable: false, displayOrder: 20 },

  // ── Contact / Location ────────────────────────────────────────────────
  email:          { display: true,  filterable: true,  displayOrder: 30 },
  department:     { display: false, filterable: true },
  institution:    { display: false, filterable: true },
  city:           { display: false, filterable: true },
  country:        { display: false, filterable: true },

  // ── Access / Activity ─────────────────────────────────────────────────
  firstaccess:    { display: false, filterable: false },
  lastaccess:     { display: true,  filterable: true,  displayOrder: 70 },
  lastcourseaccess:{ display: false, filterable: false },

  // ── Auth / Status ─────────────────────────────────────────────────────
  auth:           { display: false, filterable: false },
  confirmed:      { display: false, filterable: true },
  suspended:      { display: true,  filterable: true,  displayOrder: 100 },

  // ── Preferences ───────────────────────────────────────────────────────
  lang:           { display: false, filterable: false },
  theme:          { display: false, filterable: false },
  timezone:       { display: false, filterable: false },
  mailformat:     { display: false, filterable: false },
  maildisplay:    { display: false, filterable: false },
  trackforums:    { display: false, filterable: false },

  // ── Profile ───────────────────────────────────────────────────────────
  description:    { display: false, filterable: false },
  descriptionformat: { display: false, filterable: false },
  profileimageurl:       { display: false, filterable: false },
  profileimageurlsmall:  { display: false, filterable: false },

  // ── Local custom profile fields ───────────────────────────────────────
  Health:         { display: true,  filterable: true,  displayOrder: 40 },
  eBooksAccess:   { display: true,  filterable: true,  displayOrder: 50 },
  inclassroomstudent: { display: true, filterable: true, displayOrder: 60 },
  liveonlinestudent: { display: true, filterable: true, displayOrder: 80 },
  school:         { display: true,  filterable: true,  displayOrder: 90 },

  // ── Phone ─────────────────────────────────────────────────────────────
  phone2:         { display: false, filterable: false },

  // ── System (never displayed, never filtered) ──────────────────────────
  roles:          { display: false, filterable: false },
  groups:         { display: false, filterable: false },
  enrolledcourses:{ display: false, filterable: false },
  preferences:    { display: false, filterable: false },
};

/**
 * Return defaults for a field key, using the catch-all default for unknown fields.
 */
export function getDefaults(key: string): FieldDefaults {
  return USER_FIELD_DEFAULTS[key] ?? { display: true, filterable: true };
}
