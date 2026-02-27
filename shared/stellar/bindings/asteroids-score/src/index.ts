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




export const ScoreError = {
  1: {message:"InvalidJournalFormat"},
  2: {message:"InvalidRulesDigest"},
  3: {message:"JournalAlreadyClaimed"},
  4: {message:"ZeroScoreNotAllowed"},
  5: {message:"ScoreNotImproved"},
  6: {message:"ContractPaused"},
  7: {message:"SeedNotActive"}
}


export interface CurrentSeed {
  seed: u32;
  seed_id: u32;
}


export interface Client {
  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: upgrade this contract to a new wasm hash.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a image_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the currently configured image ID used for receipt verification.
   */
  image_id: (options?: MethodOptions) => Promise<AssembledTransaction<Buffer>>

  /**
   * Construct and simulate a token_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the configured reward token contract address.
   */
  token_id: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a router_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the configured RISC Zero router contract address.
   */
  router_id: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: transfer admin role.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a best_score transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read a claimant's best score for a specific `seed_id`.
   *
   * Returns `0` when no prior score exists.
   */
  best_score: ({claimant, seed_id}: {claimant: string, seed_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a is_claimed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Check whether a journal digest has already been claimed.
   *
   * Arguments:
   * - `env`: Soroban execution environment.
   * - `journal_digest`: SHA-256 digest of the raw journal bytes.
   */
  is_claimed: ({journal_digest}: {journal_digest: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: pause or unpause score submissions.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a current_seed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the current window's seed, materializing it on first call per window.
   *
   * This method writes only one deterministic key:
   * `SeedById(seed_id) -> seed`.
   */
  current_seed: (options?: MethodOptions) => Promise<AssembledTransaction<CurrentSeed>>

  /**
   * Construct and simulate a rules_digest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the hard-coded rules digest expected in verified journals.
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
   * Verify a RISC Zero proof and mint KALIEN tokens.
   *
   * - `seal`: variable-length proof seal bytes
   * - `journal_raw`: raw 64-byte journal bytes:
   * - 7 x u32 LE fields
   * - claimant payload (kind + 32-byte id)
   * - 3 reserved zero bytes
   *
   * Returns the claimant's new best score for this `seed_id`.
   *
   * Errors:
   * - `ContractPaused` if submissions are disabled.
   * - `InvalidJournalFormat`/`InvalidRulesDigest` for malformed or mismatched journal data.
   * - `SeedNotActive` if the `(seed_id, seed)` pair is not active.
   * - `JournalAlreadyClaimed` on replay.
   * - `ZeroScoreNotAllowed` or `ScoreNotImproved` for policy violations.
   */
  submit_score: ({seal, journal_raw}: {seal: Buffer, journal_raw: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a verify_score transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Verify a RISC Zero proof without minting rewards or mutating claim state.
   *
   * Returns the `final_score` carried by the verified journal.
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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAAClNjb3JlRXJyb3IAAAAAAAcAAAAAAAAAFEludmFsaWRKb3VybmFsRm9ybWF0AAAAAQAAAAAAAAASSW52YWxpZFJ1bGVzRGlnZXN0AAAAAAACAAAAAAAAABVKb3VybmFsQWxyZWFkeUNsYWltZWQAAAAAAAADAAAAAAAAABNaZXJvU2NvcmVOb3RBbGxvd2VkAAAAAAQAAAAAAAAAEFNjb3JlTm90SW1wcm92ZWQAAAAFAAAAAAAAAA5Db250cmFjdFBhdXNlZAAAAAAABgAAAAAAAAANU2VlZE5vdEFjdGl2ZQAAAAAAAAc=",
        "AAAAAQAAAAAAAAAAAAAAC0N1cnJlbnRTZWVkAAAAAAIAAAAAAAAABHNlZWQAAAAEAAAAAAAAAAdzZWVkX2lkAAAAAAQ=",
        "AAAABQAAAAAAAAAAAAAADlNjb3JlU3VibWl0dGVkAAAAAAABAAAAD3Njb3JlX3N1Ym1pdHRlZAAAAAAIAAAAAAAAAAhjbGFpbWFudAAAABMAAAAAAAAAAAAAAARzZWVkAAAABAAAAAAAAAAAAAAAB3NlZWRfaWQAAAAABAAAAAAAAAAAAAAAC2ZyYW1lX2NvdW50AAAAAAQAAAAAAAAAAAAAAAtmaW5hbF9zY29yZQAAAAAEAAAAAAAAAAAAAAANcHJldmlvdXNfYmVzdAAAAAAAAAQAAAAAAAAAAAAAAAhuZXdfYmVzdAAAAAQAAAAAAAAAAAAAAAxtaW50ZWRfZGVsdGEAAAAEAAAAAAAAAAI=",
        "AAAAAAAAADBBZG1pbjogdXBncmFkZSB0aGlzIGNvbnRyYWN0IHRvIGEgbmV3IHdhc20gaGFzaC4AAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAAEVSZWFkIHRoZSBjdXJyZW50bHkgY29uZmlndXJlZCBpbWFnZSBJRCB1c2VkIGZvciByZWNlaXB0IHZlcmlmaWNhdGlvbi4AAAAAAAAIaW1hZ2VfaWQAAAAAAAAAAQAAA+4AAAAg",
        "AAAAAAAAADJSZWFkIHRoZSBjb25maWd1cmVkIHJld2FyZCB0b2tlbiBjb250cmFjdCBhZGRyZXNzLgAAAAAACHRva2VuX2lkAAAAAAAAAAEAAAAT",
        "AAAAAAAAADZSZWFkIHRoZSBjb25maWd1cmVkIFJJU0MgWmVybyByb3V0ZXIgY29udHJhY3QgYWRkcmVzcy4AAAAAAAlyb3V0ZXJfaWQAAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAABtBZG1pbjogdHJhbnNmZXIgYWRtaW4gcm9sZS4AAAAACXNldF9hZG1pbgAAAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAAA",
        "AAAAAAAAAF9SZWFkIGEgY2xhaW1hbnQncyBiZXN0IHNjb3JlIGZvciBhIHNwZWNpZmljIGBzZWVkX2lkYC4KClJldHVybnMgYDBgIHdoZW4gbm8gcHJpb3Igc2NvcmUgZXhpc3RzLgAAAAAKYmVzdF9zY29yZQAAAAAAAgAAAAAAAAAIY2xhaW1hbnQAAAATAAAAAAAAAAdzZWVkX2lkAAAAAAQAAAABAAAABA==",
        "AAAAAAAAAKlDaGVjayB3aGV0aGVyIGEgam91cm5hbCBkaWdlc3QgaGFzIGFscmVhZHkgYmVlbiBjbGFpbWVkLgoKQXJndW1lbnRzOgotIGBlbnZgOiBTb3JvYmFuIGV4ZWN1dGlvbiBlbnZpcm9ubWVudC4KLSBgam91cm5hbF9kaWdlc3RgOiBTSEEtMjU2IGRpZ2VzdCBvZiB0aGUgcmF3IGpvdXJuYWwgYnl0ZXMuAAAAAAAACmlzX2NsYWltZWQAAAAAAAEAAAAAAAAADmpvdXJuYWxfZGlnZXN0AAAAAAPuAAAAIAAAAAEAAAAB",
        "AAAAAAAAACpBZG1pbjogcGF1c2Ugb3IgdW5wYXVzZSBzY29yZSBzdWJtaXNzaW9ucy4AAAAAAApzZXRfcGF1c2VkAAAAAAABAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAAA",
        "AAAAAAAAAJlSZXR1cm4gdGhlIGN1cnJlbnQgd2luZG93J3Mgc2VlZCwgbWF0ZXJpYWxpemluZyBpdCBvbiBmaXJzdCBjYWxsIHBlciB3aW5kb3cuCgpUaGlzIG1ldGhvZCB3cml0ZXMgb25seSBvbmUgZGV0ZXJtaW5pc3RpYyBrZXk6CmBTZWVkQnlJZChzZWVkX2lkKSAtPiBzZWVkYC4AAAAAAAAMY3VycmVudF9zZWVkAAAAAAAAAAEAAAfQAAAAC0N1cnJlbnRTZWVkAA==",
        "AAAAAAAAAD9SZWFkIHRoZSBoYXJkLWNvZGVkIHJ1bGVzIGRpZ2VzdCBleHBlY3RlZCBpbiB2ZXJpZmllZCBqb3VybmFscy4AAAAADHJ1bGVzX2RpZ2VzdAAAAAAAAAABAAAABA==",
        "AAAAAAAAADJBZG1pbjogdXBkYXRlIHRoZSBpbWFnZSBJRCAoZm9yIHByb2dyYW0gdXBncmFkZXMpLgAAAAAADHNldF9pbWFnZV9pZAAAAAEAAAAAAAAADG5ld19pbWFnZV9pZAAAA+4AAAAgAAAAAA==",
        "AAAAAAAAACBBZG1pbjogdXBkYXRlIHRoZSB0b2tlbiBhZGRyZXNzLgAAAAxzZXRfdG9rZW5faWQAAAABAAAAAAAAAAxuZXdfdG9rZW5faWQAAAATAAAAAA==",
        "AAAAAAAAAlBWZXJpZnkgYSBSSVNDIFplcm8gcHJvb2YgYW5kIG1pbnQgS0FMSUVOIHRva2Vucy4KCi0gYHNlYWxgOiB2YXJpYWJsZS1sZW5ndGggcHJvb2Ygc2VhbCBieXRlcwotIGBqb3VybmFsX3Jhd2A6IHJhdyA2NC1ieXRlIGpvdXJuYWwgYnl0ZXM6Ci0gNyB4IHUzMiBMRSBmaWVsZHMKLSBjbGFpbWFudCBwYXlsb2FkIChraW5kICsgMzItYnl0ZSBpZCkKLSAzIHJlc2VydmVkIHplcm8gYnl0ZXMKClJldHVybnMgdGhlIGNsYWltYW50J3MgbmV3IGJlc3Qgc2NvcmUgZm9yIHRoaXMgYHNlZWRfaWRgLgoKRXJyb3JzOgotIGBDb250cmFjdFBhdXNlZGAgaWYgc3VibWlzc2lvbnMgYXJlIGRpc2FibGVkLgotIGBJbnZhbGlkSm91cm5hbEZvcm1hdGAvYEludmFsaWRSdWxlc0RpZ2VzdGAgZm9yIG1hbGZvcm1lZCBvciBtaXNtYXRjaGVkIGpvdXJuYWwgZGF0YS4KLSBgU2VlZE5vdEFjdGl2ZWAgaWYgdGhlIGAoc2VlZF9pZCwgc2VlZClgIHBhaXIgaXMgbm90IGFjdGl2ZS4KLSBgSm91cm5hbEFscmVhZHlDbGFpbWVkYCBvbiByZXBsYXkuCi0gYFplcm9TY29yZU5vdEFsbG93ZWRgIG9yIGBTY29yZU5vdEltcHJvdmVkYCBmb3IgcG9saWN5IHZpb2xhdGlvbnMuAAAADHN1Ym1pdF9zY29yZQAAAAIAAAAAAAAABHNlYWwAAAAOAAAAAAAAAAtqb3VybmFsX3JhdwAAAAAOAAAAAQAAA+kAAAAEAAAH0AAAAApTY29yZUVycm9yAAA=",
        "AAAAAAAAAIVWZXJpZnkgYSBSSVNDIFplcm8gcHJvb2Ygd2l0aG91dCBtaW50aW5nIHJld2FyZHMgb3IgbXV0YXRpbmcgY2xhaW0gc3RhdGUuCgpSZXR1cm5zIHRoZSBgZmluYWxfc2NvcmVgIGNhcnJpZWQgYnkgdGhlIHZlcmlmaWVkIGpvdXJuYWwuAAAAAAAADHZlcmlmeV9zY29yZQAAAAIAAAAAAAAABHNlYWwAAAAOAAAAAAAAAAtqb3VybmFsX3JhdwAAAAAOAAAAAQAAA+kAAAAEAAAH0AAAAApTY29yZUVycm9yAAA=",
        "AAAAAAAAAX1Jbml0aWFsaXplIGltbXV0YWJsZSBhbmQgbXV0YWJsZSBjb25maWd1cmF0aW9uIGZvciB0aGUgY29udHJhY3QgaW5zdGFuY2UuCgpBcmd1bWVudHM6Ci0gYGVudmA6IFNvcm9iYW4gZXhlY3V0aW9uIGVudmlyb25tZW50LgotIGBhZG1pbmA6IEFkZHJlc3MgYXV0aG9yaXplZCBmb3IgYWRtaW4tb25seSBtZXRob2RzLgotIGByb3V0ZXJfaWRgOiBSSVNDIFplcm8gcm91dGVyIGNvbnRyYWN0IGFkZHJlc3MgdXNlZCBmb3IgcHJvb2YgdmVyaWZpY2F0aW9uLgotIGBpbWFnZV9pZGA6IEV4cGVjdGVkIFJJU0MgWmVybyBpbWFnZSBJRCBmb3IgdmFsaWQgcmVjZWlwdHMuCi0gYHRva2VuX2lkYDogU3RlbGxhciBhc3NldCBjb250cmFjdCB1c2VkIGZvciByZXdhcmQgbWludGluZy4AAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAJcm91dGVyX2lkAAAAAAAAEwAAAAAAAAAIaW1hZ2VfaWQAAAPuAAAAIAAAAAAAAAAIdG9rZW5faWQAAAATAAAAAA==",
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
        is_claimed: this.txFromJSON<boolean>,
        set_paused: this.txFromJSON<null>,
        current_seed: this.txFromJSON<CurrentSeed>,
        rules_digest: this.txFromJSON<u32>,
        set_image_id: this.txFromJSON<null>,
        set_token_id: this.txFromJSON<null>,
        submit_score: this.txFromJSON<Result<u32>>,
        verify_score: this.txFromJSON<Result<u32>>,
        set_router_id: this.txFromJSON<null>
  }
}