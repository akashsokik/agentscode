import type { ComponentPropsWithRef } from "react";

type Props = Omit<ComponentPropsWithRef<"button">, "className"> & {
  danger?: boolean;
};

export function SecondaryButton({
  danger = false,
  type = "button",
  children,
  ...props
}: Props) {
  return (
    <button
      {...props}
      type={type}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-content/10 px-2.5 text-[12px] transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] ${
        danger
          ? "text-danger hover:border-danger/40 hover:bg-danger/10"
          : "text-content/70 hover:bg-content/10 hover:text-content"
      } disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:active:scale-100`}
    >
      {children}
    </button>
  );
}
