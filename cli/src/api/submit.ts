export interface SubmitResult {
  success: boolean;
  jobId?: string;
  statusUrl?: string;
  error?: string;
  rateLimited?: boolean;
}

export async function submitTape(
  tapeBytes: Uint8Array,
  address: string,
  apiUrl: string,
): Promise<SubmitResult> {
  const url = `${apiUrl}/api/proofs/jobs`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-claimant-address": address,
      },
      body: tapeBytes,
    });

    if (response.status === 429) {
      let error = "Rate limited";
      try {
        const body = await response.json() as { error?: string };
        if (body.error) error = body.error;
      } catch {}
      return { success: false, error, rateLimited: true };
    }

    if (!response.ok) {
      let error = `HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) error = body.error;
      } catch {}
      return { success: false, error };
    }

    const data = await response.json() as {
      success: boolean;
      status_url?: string;
      job?: { jobId: string };
    };

    return {
      success: true,
      jobId: data.job?.jobId,
      statusUrl: data.status_url,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
