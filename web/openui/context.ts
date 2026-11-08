import { createContext } from 'react';

/** How a button click in an OpenUI block reaches the agent: send this text as the user's message. Null outside an agent's transcript. */
export const OpenUIActionContext = createContext<((text: string) => void) | null>(null);
