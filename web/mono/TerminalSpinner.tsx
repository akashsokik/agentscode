import { useEffect, useState } from "react";

const FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Sizing every spinner shares; `className` adds to it, usually just a text colour. */
const BASE =
  "inline-block w-3.5 shrink-0 select-none text-center text-[11px] leading-none";

export function TerminalSpinner({ className = "" }: { className?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = window.setInterval(
      () => setFrame((n) => (n + 1) % FRAMES.length),
      80,
    );
    return () => window.clearInterval(id);
  }, []);

  return (
    <span aria-hidden className={`${BASE} ${className}`}>
      {FRAMES[frame]}
    </span>
  );
}
