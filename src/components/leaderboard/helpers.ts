import type { ClaimStatus } from "@/proof/api";

export function claimStatusBadgeVariant(status: ClaimStatus): "success" | "error" | "info" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    default:
      return "info";
  }
}
