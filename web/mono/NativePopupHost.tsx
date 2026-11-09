import { createContext } from "react";

/** A dedicated native popup already owns positioning and clipping. */
export const NativePopupHost = createContext<HTMLElement | null>(null);
