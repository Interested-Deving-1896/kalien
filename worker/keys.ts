export function tapeKey(jobId: string): string {
  return `proof-jobs/${jobId}/input.tape`;
}

export function resultKey(jobId: string): string {
  return `proof-jobs/${jobId}/result.json`;
}
