import type { Lang } from '../config/schema.js';
import en from './en.json' with { type: 'json' };
import ko from './ko.json' with { type: 'json' };

export type MessageKey = keyof typeof en;
export type MessageParams = Readonly<Record<string, string | number>>;

export const CATALOGS: Readonly<Record<Lang, Readonly<Record<MessageKey, string>>>> = { en, ko };

const PLACEHOLDER = /\{(\w+)\}/g;

/** `--lang` first, then the config `lang`, else English. */
export function selectLang(flag: Lang | undefined, configLang: Lang | undefined): Lang {
  return flag ?? configLang ?? 'en';
}

export function isLang(value: string): value is Lang {
  return value === 'en' || value === 'ko';
}

/** Texts that count something, written as `<key>.one` and `<key>.other`. */
export type CountedKey = {
  [K in MessageKey]: K extends `${infer Base}.one`
    ? `${Base}.other` extends MessageKey
      ? Base
      : never
    : never;
}[MessageKey];

/** `<key>.one` for a count of 1, else `<key>.other`; Korean writes both forms alike. */
export function countedKey(key: CountedKey, count: number): MessageKey {
  return count === 1 ? `${key}.one` : `${key}.other`;
}

export function message(lang: Lang, key: MessageKey, params: MessageParams = {}): string {
  return CATALOGS[lang][key].replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`message ${key} needs the parameter ${name}`);
    }
    return String(value);
  });
}
