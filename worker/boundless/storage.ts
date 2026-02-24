import { IPFS_GATEWAY_PREFIX } from "./config";

/**
 * Upload raw stdin bytes to Pinata IPFS.
 * Returns the IPFS gateway URL for the uploaded content.
 */
export async function uploadInput(pinataJwt: string, stdinBytes: Uint8Array): Promise<string> {
  // Compute sha256 hex for the filename
  const hashBuffer = await crypto.subtle.digest("SHA-256", stdinBytes);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const filename = `${hashHex}.input`;

  // Build multipart form data
  const formData = new FormData();
  const blob = new Blob([stdinBytes], { type: "application/octet-stream" });
  formData.append("file", blob, filename);

  const metadata = JSON.stringify({ name: filename });
  formData.append("pinataMetadata", metadata);

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pinataJwt}`,
    },
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // Ignore parse errors.
    }
    throw new Error(`Pinata upload failed (${response.status}): ${detail || "no body"}`);
  }

  const result = (await response.json()) as { IpfsHash?: string };
  if (!result.IpfsHash) {
    throw new Error("Pinata upload response missing IpfsHash");
  }

  return `${IPFS_GATEWAY_PREFIX}${result.IpfsHash}`;
}
