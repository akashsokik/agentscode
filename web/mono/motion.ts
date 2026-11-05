/* MonoCode's motion tokens (src/shared/lib/motion.ts, MIT, see NOTICE). */
export function tabCloseDuration() {
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--motion-tab-close-duration")
    .trim();
  const duration = parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  return (Number.isFinite(duration) && duration > 0 ? duration : 0) || 180;
}
