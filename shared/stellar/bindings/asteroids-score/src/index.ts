import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}

// Compatibility export retained for scripts that import generated network defaults.
export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU",
  },
} as const;




export const ScoreError = {
  1: {message:"InvalidJournalLength"},
  2: {message:"InvalidRulesDigest"},
  3: {message:"JournalAlreadyClaimed"},
  4: {message:"ZeroScoreNotAllowed"},
  5: {message:"ScoreNotImproved"},
  6: {message:"ContractPaused"},
  7: {message:"SeedExpired"}
}


export interface Client {
  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: upgrade this contract to a new wasm hash.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a image_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the current image ID.
   */
  image_id: (options?: MethodOptions) => Promise<AssembledTransaction<Buffer>>

  /**
   * Construct and simulate a token_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the token address.
   */
  token_id: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a router_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the router address.
   */
  router_id: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: transfer admin role.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a best_score transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read a claimant's best score for a seed.
   */
  best_score: ({claimant, seed}: {claimant: string, seed: u32}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a index_seed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Index a materialized window seed for O(1) lookup during `submit_score`.
   * 
   * This call is permissionless and deterministic:
   * - verifies `ValidSeed(window) == seed`
   * - enforces that `window` is within the active 24h range
   * - stores `SeedWindow(seed) = window` in temporary storage
   * 
   * Returns `true` when the mapping is valid/present and `false` otherwise.
   */
  index_seed: ({window, seed}: {window: u32, seed: u32}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_claimed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check whether a journal digest has already been claimed.
   */
  is_claimed: ({journal_digest}: {journal_digest: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: pause or unpause score submissions.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a current_seed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the current window's random seed, materializing it on first call per window.
   * 
   * This method only writes `ValidSeed(window) -> seed` because the key is deterministic.
   * The reverse index `SeedWindow(seed) -> window` is populated separately via
   * `index_seed(window, seed)` to keep key footprints deterministic in simulation.
   */
  current_seed: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a rules_digest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the expected rules digest.
   */
  rules_digest: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a set_image_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: update the image ID (for program upgrades).
   */
  set_image_id: ({new_image_id}: {new_image_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_token_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: update the token address.
   */
  set_token_id: ({new_token_id}: {new_token_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a submit_score transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Verify a RISC Zero proof and mint KALIEN tokens to the claimant address.
   * 
   * - `seal`: variable-length proof seal bytes
   * - `journal_raw`: raw 24-byte journal bytes (6 × u32 LE)
   * - `claimant`: recipient address for KALIEN minting and best-score tracking
   * 
   * Returns the claimant's new best score for this seed.
   */
  submit_score: ({seal, journal_raw, claimant}: {seal: Buffer, journal_raw: Buffer, claimant: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a verify_score transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Verify a RISC Zero proof without minting or modifying state.
   */
  verify_score: ({seal, journal_raw}: {seal: Buffer, journal_raw: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a set_router_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: update the RISC Zero router address.
   */
  set_router_id: ({new_router_id}: {new_router_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, router_id, image_id, token_id}: {admin: string, router_id: string, image_id: Buffer, token_id: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, router_id, image_id, token_id}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAAClNjb3JlRXJyb3IAAAAAAAcAAAAAAAAAFEludmFsaWRKb3VybmFsTGVuZ3RoAAAAAQAAAAAAAAASSW52YWxpZFJ1bGVzRGlnZXN0AAAAAAACAAAAAAAAABVKb3VybmFsQWxyZWFkeUNsYWltZWQAAAAAAAADAAAAAAAAABNaZXJvU2NvcmVOb3RBbGxvd2VkAAAAAAQAAAAAAAAAEFNjb3JlTm90SW1wcm92ZWQAAAAFAAAAAAAAAA5Db250cmFjdFBhdXNlZAAAAAAABgAAAAAAAAALU2VlZEV4cGlyZWQAAAAABw==",
        "AAAABQAAAAAAAAAAAAAADlNjb3JlU3VibWl0dGVkAAAAAAABAAAAD3Njb3JlX3N1Ym1pdHRlZAAAAAALAAAAAAAAAAhjbGFpbWFudAAAABMAAAAAAAAAAAAAAARzZWVkAAAABAAAAAAAAAAAAAAAC2ZyYW1lX2NvdW50AAAAAAQAAAAAAAAAAAAAAAtmaW5hbF9zY29yZQAAAAAEAAAAAAAAAAAAAAAPZmluYWxfcm5nX3N0YXRlAAAAAAQAAAAAAAAAAAAAAA10YXBlX2NoZWNrc3VtAAAAAAAABAAAAAAAAAAAAAAADHJ1bGVzX2RpZ2VzdAAAAAQAAAAAAAAAAAAAAA1wcmV2aW91c19iZXN0AAAAAAAABAAAAAAAAAAAAAAACG5ld19iZXN0AAAABAAAAAAAAAAAAAAADG1pbnRlZF9kZWx0YQAAAAQAAAAAAAAAAAAAAA5qb3VybmFsX2RpZ2VzdAAAAAAD7gAAACAAAAAAAAAAAg==",
        "AAAAAAAAADBBZG1pbjogdXBncmFkZSB0aGlzIGNvbnRyYWN0IHRvIGEgbmV3IHdhc20gaGFzaC4AAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAABpSZWFkIHRoZSBjdXJyZW50IGltYWdlIElELgAAAAAACGltYWdlX2lkAAAAAAAAAAEAAAPuAAAAIA==",
        "AAAAAAAAABdSZWFkIHRoZSB0b2tlbiBhZGRyZXNzLgAAAAAIdG9rZW5faWQAAAAAAAAAAQAAABM=",
        "AAAAAAAAABhSZWFkIHRoZSByb3V0ZXIgYWRkcmVzcy4AAAAJcm91dGVyX2lkAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAABtBZG1pbjogdHJhbnNmZXIgYWRtaW4gcm9sZS4AAAAACXNldF9hZG1pbgAAAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAAA",
        "AAAAAAAAAChSZWFkIGEgY2xhaW1hbnQncyBiZXN0IHNjb3JlIGZvciBhIHNlZWQuAAAACmJlc3Rfc2NvcmUAAAAAAAIAAAAAAAAACGNsYWltYW50AAAAEwAAAAAAAAAEc2VlZAAAAAQAAAABAAAABA==",
        "AAAAAAAAAVlJbmRleCBhIG1hdGVyaWFsaXplZCB3aW5kb3cgc2VlZCBmb3IgTygxKSBsb29rdXAgZHVyaW5nIGBzdWJtaXRfc2NvcmVgLgoKVGhpcyBjYWxsIGlzIHBlcm1pc3Npb25sZXNzIGFuZCBkZXRlcm1pbmlzdGljOgotIHZlcmlmaWVzIGBWYWxpZFNlZWQod2luZG93KSA9PSBzZWVkYAotIGVuZm9yY2VzIHRoYXQgYHdpbmRvd2AgaXMgd2l0aGluIHRoZSBhY3RpdmUgMjRoIHJhbmdlCi0gc3RvcmVzIGBTZWVkV2luZG93KHNlZWQpID0gd2luZG93YCBpbiB0ZW1wb3Jhcnkgc3RvcmFnZQoKUmV0dXJucyBgdHJ1ZWAgd2hlbiB0aGUgbWFwcGluZyBpcyB2YWxpZC9wcmVzZW50IGFuZCBgZmFsc2VgIG90aGVyd2lzZS4AAAAAAAAKaW5kZXhfc2VlZAAAAAAAAgAAAAAAAAAGd2luZG93AAAAAAAEAAAAAAAAAARzZWVkAAAABAAAAAEAAAAB",
        "AAAAAAAAADhDaGVjayB3aGV0aGVyIGEgam91cm5hbCBkaWdlc3QgaGFzIGFscmVhZHkgYmVlbiBjbGFpbWVkLgAAAAppc19jbGFpbWVkAAAAAAABAAAAAAAAAA5qb3VybmFsX2RpZ2VzdAAAAAAD7gAAACAAAAABAAAAAQ==",
        "AAAAAAAAACpBZG1pbjogcGF1c2Ugb3IgdW5wYXVzZSBzY29yZSBzdWJtaXNzaW9ucy4AAAAAAApzZXRfcGF1c2VkAAAAAAABAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAAA",
        "AAAAAAAAAURSZXR1cm4gdGhlIGN1cnJlbnQgd2luZG93J3MgcmFuZG9tIHNlZWQsIG1hdGVyaWFsaXppbmcgaXQgb24gZmlyc3QgY2FsbCBwZXIgd2luZG93LgoKVGhpcyBtZXRob2Qgb25seSB3cml0ZXMgYFZhbGlkU2VlZCh3aW5kb3cpIC0+IHNlZWRgIGJlY2F1c2UgdGhlIGtleSBpcyBkZXRlcm1pbmlzdGljLgpUaGUgcmV2ZXJzZSBpbmRleCBgU2VlZFdpbmRvdyhzZWVkKSAtPiB3aW5kb3dgIGlzIHBvcHVsYXRlZCBzZXBhcmF0ZWx5IHZpYQpgaW5kZXhfc2VlZCh3aW5kb3csIHNlZWQpYCB0byBrZWVwIGtleSBmb290cHJpbnRzIGRldGVybWluaXN0aWMgaW4gc2ltdWxhdGlvbi4AAAAMY3VycmVudF9zZWVkAAAAAAAAAAEAAAAE",
        "AAAAAAAAAB9SZWFkIHRoZSBleHBlY3RlZCBydWxlcyBkaWdlc3QuAAAAAAxydWxlc19kaWdlc3QAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAADJBZG1pbjogdXBkYXRlIHRoZSBpbWFnZSBJRCAoZm9yIHByb2dyYW0gdXBncmFkZXMpLgAAAAAADHNldF9pbWFnZV9pZAAAAAEAAAAAAAAADG5ld19pbWFnZV9pZAAAA+4AAAAgAAAAAA==",
        "AAAAAAAAACBBZG1pbjogdXBkYXRlIHRoZSB0b2tlbiBhZGRyZXNzLgAAAAxzZXRfdG9rZW5faWQAAAABAAAAAAAAAAxuZXdfdG9rZW5faWQAAAATAAAAAA==",
        "AAAAAAAAAS5WZXJpZnkgYSBSSVNDIFplcm8gcHJvb2YgYW5kIG1pbnQgS0FMSUVOIHRva2VucyB0byB0aGUgY2xhaW1hbnQgYWRkcmVzcy4KCi0gYHNlYWxgOiB2YXJpYWJsZS1sZW5ndGggcHJvb2Ygc2VhbCBieXRlcwotIGBqb3VybmFsX3Jhd2A6IHJhdyAyNC1ieXRlIGpvdXJuYWwgYnl0ZXMgKDYgw5cgdTMyIExFKQotIGBjbGFpbWFudGA6IHJlY2lwaWVudCBhZGRyZXNzIGZvciBLQUxJRU4gbWludGluZyBhbmQgYmVzdC1zY29yZSB0cmFja2luZwoKUmV0dXJucyB0aGUgY2xhaW1hbnQncyBuZXcgYmVzdCBzY29yZSBmb3IgdGhpcyBzZWVkLgAAAAAADHN1Ym1pdF9zY29yZQAAAAMAAAAAAAAABHNlYWwAAAAOAAAAAAAAAAtqb3VybmFsX3JhdwAAAAAOAAAAAAAAAAhjbGFpbWFudAAAABMAAAABAAAD6QAAAAQAAAfQAAAAClNjb3JlRXJyb3IAAA==",
        "AAAAAAAAADxWZXJpZnkgYSBSSVNDIFplcm8gcHJvb2Ygd2l0aG91dCBtaW50aW5nIG9yIG1vZGlmeWluZyBzdGF0ZS4AAAAMdmVyaWZ5X3Njb3JlAAAAAgAAAAAAAAAEc2VhbAAAAA4AAAAAAAAAC2pvdXJuYWxfcmF3AAAAAA4AAAABAAAD6QAAAAQAAAfQAAAAClNjb3JlRXJyb3IAAA==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAJcm91dGVyX2lkAAAAAAAAEwAAAAAAAAAIaW1hZ2VfaWQAAAPuAAAAIAAAAAAAAAAIdG9rZW5faWQAAAATAAAAAA==",
        "AAAAAAAAACtBZG1pbjogdXBkYXRlIHRoZSBSSVNDIFplcm8gcm91dGVyIGFkZHJlc3MuAAAAAA1zZXRfcm91dGVyX2lkAAAAAAAAAQAAAAAAAAANbmV3X3JvdXRlcl9pZAAAAAAAABMAAAAA" ]),
      options
    )
  }
  public readonly fromJSON = {
    upgrade: this.txFromJSON<null>,
        image_id: this.txFromJSON<Buffer>,
        token_id: this.txFromJSON<string>,
        router_id: this.txFromJSON<string>,
        set_admin: this.txFromJSON<null>,
        best_score: this.txFromJSON<u32>,
        index_seed: this.txFromJSON<boolean>,
        is_claimed: this.txFromJSON<boolean>,
        set_paused: this.txFromJSON<null>,
        current_seed: this.txFromJSON<u32>,
        rules_digest: this.txFromJSON<u32>,
        set_image_id: this.txFromJSON<null>,
        set_token_id: this.txFromJSON<null>,
        submit_score: this.txFromJSON<Result<u32>>,
        verify_score: this.txFromJSON<Result<u32>>,
        set_router_id: this.txFromJSON<null>
  }
}
