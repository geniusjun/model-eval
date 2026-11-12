/** The two compared runs, in the column order of every table of the page. */
export const ROLES = ['baseline', 'candidate'] as const;

export type Role = (typeof ROLES)[number];

/** A value for each compared run. */
export type PerRole<T> = Readonly<Record<Role, T>>;

/** `variant.id` of the baseline and the candidate run, which name the variants on the page. */
export type VariantIds = PerRole<string>;
