import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function ErrorDetailDialog({
  error,
  children,
}: {
  error: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogTitle>Error Details</DialogTitle>
        <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/20 bg-[rgba(8,16,29,0.6)] p-3 font-mono text-xs text-destructive/90">
          {error}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
