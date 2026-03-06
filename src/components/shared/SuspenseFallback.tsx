import Loader2 from "lucide-react/dist/esm/icons/loader-2";

export function SuspenseFallback() {
  return (
    <div className="flex min-h-[200px] items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}
