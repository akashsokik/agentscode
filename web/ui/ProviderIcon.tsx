import anthropicMark from '../assets/providers/anthropic.svg';
import ollamaMark from '../assets/providers/ollama.svg';
import openaiMark from '../assets/providers/openai.svg';
import openrouterMark from '../assets/providers/openrouter.svg';
import vercelMark from '../assets/providers/vercel.svg';
import codexLogo from '../assets/codex.svg';
import { MonoMark } from './EngineIcon.tsx';

/**
 * OrcaCode's model providers. Marks are from Simple Icons (CC0; trademarks of their owners), drawn
 * in the text color. OpenAI Codex uses the Codex logo; a provider with no mark gets its initial.
 */
const MARKS: Record<string, string> = {
  openrouter: openrouterMark,
  vercel: vercelMark,
  anthropic: anthropicMark,
  openai: openaiMark,
  local: ollamaMark,
};

export function ProviderIcon({ provider, label, className = 'size-4' }: { provider: string; label: string; className?: string }) {
  if (provider === 'openai-codex') return <img src={codexLogo} alt={label} title={label} className={`shrink-0 select-none ${className}`} draggable={false} />;
  const mark = MARKS[provider];
  if (mark) return <MonoMark src={mark} label={label} className={className} />;
  return (
    <span role="img" aria-label={label} title={label} className={`grid shrink-0 place-items-center rounded-[4px] border border-current text-[9px] font-semibold leading-none ${className}`}>
      {label.charAt(0).toUpperCase()}
    </span>
  );
}
