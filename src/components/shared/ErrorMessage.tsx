import { cn } from "@/lib/utils";

export interface ErrorMessageProps {
  message: string | null | undefined;
  severity?: "warning" | "error";
  className?: string;
}

export function ErrorMessage({ message, severity = "error", className }: ErrorMessageProps) {
  if (!message) return null;
  return (
    <p
      className={cn(
        "m-0 text-sm [overflow-wrap:anywhere]",
        severity === "warning" ? "text-warning" : "text-[#ffabab]",
        className,
      )}
    >
      {message}
    </p>
  );
}
