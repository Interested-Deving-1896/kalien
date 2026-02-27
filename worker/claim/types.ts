export interface RelayClaimRequest {
  jobId: string;
  journalRawHex: string;
  journalDigestHex: string;
  sealHex: string;
}

export type RelaySubmitResult =
  | { type: "success"; txHash: string }
  | { type: "retry"; message: string; errorDetail?: string }
  | { type: "fatal"; message: string; errorDetail?: string };
