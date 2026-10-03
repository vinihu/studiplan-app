import { useCallback, useState } from "react";

/**
 * Where the user is. The one place that knows it.
 *
 * The app has no URLs and no router: a location is the selected subject and, when a material is
 * open, that material — or Settings, which stands beside the library. Leaving Settings goes back
 * to where the user was. The selected subject is remembered across restarts; an open material
 * and Settings are not, so the app always starts on the Library.
 *
 * A result opened for studying is a location (so Settings and back returns to it); a file
 * opened inside a material is not: it is part of the Material screen.
 */
export interface Location {
  /** Folder name of the selected subject, or `null` before one is chosen. */
  subject: string | null;
  /** Folder name of the open material, or `null` on the Library screen. */
  material: string | null;
  /** File name of the result open in the Study screen, or `null`. Only with a material. */
  result: string | null;
  /** True while Settings is showing instead of the library. */
  settings: boolean;
}

export interface Navigation {
  location: Location;
  /** Shows the Library with this subject selected. */
  selectSubject: (subject: string | null) => void;
  /** Opens a material of a subject. */
  openMaterial: (subject: string, material: string) => void;
  /** Back from a material to its subject's list. */
  closeMaterial: () => void;
  /** Opens one of the open material's results in the Study screen. */
  openResult: (name: string) => void;
  /** Opens a result of any material, from somewhere else in the app. */
  openResultOf: (subject: string, material: string, name: string) => void;
  /** Back from a result to its material. */
  closeResult: () => void;
  /** Shows Settings. The subject and material stay as they are underneath. */
  openSettings: () => void;
  /** Back from Settings to where the user was. */
  closeSettings: () => void;
}

const LAST_SUBJECT_KEY = "studiplan.lastSubject";

function readLastSubject(): string | null {
  try {
    return window.localStorage.getItem(LAST_SUBJECT_KEY);
  } catch {
    return null;
  }
}

function rememberSubject(subject: string | null): void {
  try {
    if (subject === null) window.localStorage.removeItem(LAST_SUBJECT_KEY);
    else window.localStorage.setItem(LAST_SUBJECT_KEY, subject);
  } catch {
    // A view preference: losing it only means starting on the first subject.
  }
}

export function useNavigation(): Navigation {
  const [location, setLocation] = useState<Location>(() => ({
    subject: readLastSubject(),
    material: null,
    result: null,
    settings: false,
  }));

  const selectSubject = useCallback((subject: string | null) => {
    rememberSubject(subject);
    setLocation({ subject, material: null, result: null, settings: false });
  }, []);

  const openMaterial = useCallback((subject: string, material: string) => {
    rememberSubject(subject);
    setLocation({ subject, material, result: null, settings: false });
  }, []);

  const closeMaterial = useCallback(() => {
    setLocation((current) => ({ ...current, material: null, result: null }));
  }, []);

  const openResult = useCallback((name: string) => {
    setLocation((current) => (current.material === null ? current : { ...current, result: name }));
  }, []);

  const openResultOf = useCallback((subject: string, material: string, name: string) => {
    rememberSubject(subject);
    setLocation({ subject, material, result: name, settings: false });
  }, []);

  const closeResult = useCallback(() => {
    setLocation((current) => ({ ...current, result: null }));
  }, []);

  const openSettings = useCallback(() => {
    setLocation((current) => ({ ...current, settings: true }));
  }, []);

  const closeSettings = useCallback(() => {
    setLocation((current) => ({ ...current, settings: false }));
  }, []);

  return {
    location,
    selectSubject,
    openMaterial,
    closeMaterial,
    openResult,
    openResultOf,
    closeResult,
    openSettings,
    closeSettings,
  };
}
