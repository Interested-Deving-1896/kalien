export interface ProofRequest {
  id: bigint;
  requirements: Requirements;
  imageUrl: string;
  input: Input;
  offer: Offer;
}

export interface Requirements {
  callback: Callback;
  predicate: Predicate;
  selector: `0x${string}`;
}

export interface Predicate {
  predicateType: number; // uint8 enum: 0=DigestMatch, 1=PrefixMatch, 2=ClaimDigestMatch
  data: `0x${string}`;
}

export interface Callback {
  addr: `0x${string}`;
  gasLimit: bigint; // uint96
}

export interface Input {
  inputType: number; // uint8 enum: 0=Inline, 1=Url
  data: `0x${string}`;
}

export interface Offer {
  minPrice: bigint;
  maxPrice: bigint;
  rampUpStart: bigint; // uint64
  rampUpPeriod: number; // uint32, seconds
  lockTimeout: number; // uint32, seconds from rampUpStart
  timeout: number; // uint32, seconds from rampUpStart
  lockCollateral: bigint;
}

export interface FulfillmentData {
  seal: Uint8Array;
  journal: Uint8Array;
}

