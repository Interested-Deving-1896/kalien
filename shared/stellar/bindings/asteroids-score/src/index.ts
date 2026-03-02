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
   * Construct and simulate a verifier_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read the configured RISC Zero verifier contract address.
   */
  verifier_id: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

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
   * Read the hard-coded rules digest for AST4 verifier policy.
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
   * - `journal_raw`: raw 49-byte journal bytes:
   * - 4 x u32 LE fields (`seed_id`, `seed`, `frame_count`, `final_score`)
   * - claimant payload (kind + 32-byte id)
   * 
   * Returns the claimant's new best score for this `seed_id`.
   * 
   * Errors:
   * - `ContractPaused` if submissions are disabled.
   * - `InvalidJournalFormat` for malformed journal data.
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
   * Construct and simulate a set_verifier_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: update the RISC Zero verifier address.
   */
  set_verifier_id: ({new_verifier_id}: {new_verifier_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, verifier_id, image_id, token_id}: {admin: string, verifier_id: string, image_id: Buffer, token_id: string},
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
    return ContractClient.deploy({admin, verifier_id, image_id, token_id}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAAClNjb3JlRXJyb3IAAAAAAAYAAAAAAAAAFEludmFsaWRKb3VybmFsRm9ybWF0AAAAAQAAAAAAAAAVSm91cm5hbEFscmVhZHlDbGFpbWVkAAAAAAAAAwAAAAAAAAATWmVyb1Njb3JlTm90QWxsb3dlZAAAAAAEAAAAAAAAABBTY29yZU5vdEltcHJvdmVkAAAABQAAAAAAAAAOQ29udHJhY3RQYXVzZWQAAAAAAAYAAAAAAAAADVNlZWROb3RBY3RpdmUAAAAAAAAH",
        "AAAAAQAAAAAAAAAAAAAAC0N1cnJlbnRTZWVkAAAAAAIAAAAAAAAABHNlZWQAAAAEAAAAAAAAAAdzZWVkX2lkAAAAAAQ=",
        "AAAABQAAAAAAAAAAAAAADlNjb3JlU3VibWl0dGVkAAAAAAABAAAAD3Njb3JlX3N1Ym1pdHRlZAAAAAAIAAAAAAAAAAdzZWVkX2lkAAAAAAQAAAAAAAAAAAAAAARzZWVkAAAABAAAAAAAAAAAAAAAC2ZyYW1lX2NvdW50AAAAAAQAAAAAAAAAAAAAAAtmaW5hbF9zY29yZQAAAAAEAAAAAAAAAAAAAAAIY2xhaW1hbnQAAAATAAAAAAAAAAAAAAANcHJldmlvdXNfYmVzdAAAAAAAAAQAAAAAAAAAAAAAAAhuZXdfYmVzdAAAAAQAAAAAAAAAAAAAAAxtaW50ZWRfZGVsdGEAAAAEAAAAAAAAAAI=",
        "AAAAAAAAADBBZG1pbjogdXBncmFkZSB0aGlzIGNvbnRyYWN0IHRvIGEgbmV3IHdhc20gaGFzaC4AAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAAAAAEVSZWFkIHRoZSBjdXJyZW50bHkgY29uZmlndXJlZCBpbWFnZSBJRCB1c2VkIGZvciByZWNlaXB0IHZlcmlmaWNhdGlvbi4AAAAAAAAIaW1hZ2VfaWQAAAAAAAAAAQAAA+4AAAAg",
        "AAAAAAAAADJSZWFkIHRoZSBjb25maWd1cmVkIHJld2FyZCB0b2tlbiBjb250cmFjdCBhZGRyZXNzLgAAAAAACHRva2VuX2lkAAAAAAAAAAEAAAAT",
        "AAAAAAAAABtBZG1pbjogdHJhbnNmZXIgYWRtaW4gcm9sZS4AAAAACXNldF9hZG1pbgAAAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAAA",
        "AAAAAAAAAF9SZWFkIGEgY2xhaW1hbnQncyBiZXN0IHNjb3JlIGZvciBhIHNwZWNpZmljIGBzZWVkX2lkYC4KClJldHVybnMgYDBgIHdoZW4gbm8gcHJpb3Igc2NvcmUgZXhpc3RzLgAAAAAKYmVzdF9zY29yZQAAAAAAAgAAAAAAAAAIY2xhaW1hbnQAAAATAAAAAAAAAAdzZWVkX2lkAAAAAAQAAAABAAAABA==",
        "AAAAAAAAAKlDaGVjayB3aGV0aGVyIGEgam91cm5hbCBkaWdlc3QgaGFzIGFscmVhZHkgYmVlbiBjbGFpbWVkLgoKQXJndW1lbnRzOgotIGBlbnZgOiBTb3JvYmFuIGV4ZWN1dGlvbiBlbnZpcm9ubWVudC4KLSBgam91cm5hbF9kaWdlc3RgOiBTSEEtMjU2IGRpZ2VzdCBvZiB0aGUgcmF3IGpvdXJuYWwgYnl0ZXMuAAAAAAAACmlzX2NsYWltZWQAAAAAAAEAAAAAAAAADmpvdXJuYWxfZGlnZXN0AAAAAAPuAAAAIAAAAAEAAAAB",
        "AAAAAAAAACpBZG1pbjogcGF1c2Ugb3IgdW5wYXVzZSBzY29yZSBzdWJtaXNzaW9ucy4AAAAAAApzZXRfcGF1c2VkAAAAAAABAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAAA",
        "AAAAAAAAADhSZWFkIHRoZSBjb25maWd1cmVkIFJJU0MgWmVybyB2ZXJpZmllciBjb250cmFjdCBhZGRyZXNzLgAAAAt2ZXJpZmllcl9pZAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAJlSZXR1cm4gdGhlIGN1cnJlbnQgd2luZG93J3Mgc2VlZCwgbWF0ZXJpYWxpemluZyBpdCBvbiBmaXJzdCBjYWxsIHBlciB3aW5kb3cuCgpUaGlzIG1ldGhvZCB3cml0ZXMgb25seSBvbmUgZGV0ZXJtaW5pc3RpYyBrZXk6CmBTZWVkQnlJZChzZWVkX2lkKSAtPiBzZWVkYC4AAAAAAAAMY3VycmVudF9zZWVkAAAAAAAAAAEAAAfQAAAAC0N1cnJlbnRTZWVkAA==",
        "AAAAAAAAADpSZWFkIHRoZSBoYXJkLWNvZGVkIHJ1bGVzIGRpZ2VzdCBmb3IgQVNUNCB2ZXJpZmllciBwb2xpY3kuAAAAAAAMcnVsZXNfZGlnZXN0AAAAAAAAAAEAAAAE",
        "AAAAAAAAADJBZG1pbjogdXBkYXRlIHRoZSBpbWFnZSBJRCAoZm9yIHByb2dyYW0gdXBncmFkZXMpLgAAAAAADHNldF9pbWFnZV9pZAAAAAEAAAAAAAAADG5ld19pbWFnZV9pZAAAA+4AAAAgAAAAAA==",
        "AAAAAAAAACBBZG1pbjogdXBkYXRlIHRoZSB0b2tlbiBhZGRyZXNzLgAAAAxzZXRfdG9rZW5faWQAAAABAAAAAAAAAAxuZXdfdG9rZW5faWQAAAATAAAAAA==",
        "AAAAAAAAAkdWZXJpZnkgYSBSSVNDIFplcm8gcHJvb2YgYW5kIG1pbnQgS0FMSUVOIHRva2Vucy4KCi0gYHNlYWxgOiB2YXJpYWJsZS1sZW5ndGggcHJvb2Ygc2VhbCBieXRlcwotIGBqb3VybmFsX3Jhd2A6IHJhdyA0OS1ieXRlIGpvdXJuYWwgYnl0ZXM6Ci0gNCB4IHUzMiBMRSBmaWVsZHMgKGBzZWVkX2lkYCwgYHNlZWRgLCBgZnJhbWVfY291bnRgLCBgZmluYWxfc2NvcmVgKQotIGNsYWltYW50IHBheWxvYWQgKGtpbmQgKyAzMi1ieXRlIGlkKQoKUmV0dXJucyB0aGUgY2xhaW1hbnQncyBuZXcgYmVzdCBzY29yZSBmb3IgdGhpcyBgc2VlZF9pZGAuCgpFcnJvcnM6Ci0gYENvbnRyYWN0UGF1c2VkYCBpZiBzdWJtaXNzaW9ucyBhcmUgZGlzYWJsZWQuCi0gYEludmFsaWRKb3VybmFsRm9ybWF0YCBmb3IgbWFsZm9ybWVkIGpvdXJuYWwgZGF0YS4KLSBgU2VlZE5vdEFjdGl2ZWAgaWYgdGhlIGAoc2VlZF9pZCwgc2VlZClgIHBhaXIgaXMgbm90IGFjdGl2ZS4KLSBgSm91cm5hbEFscmVhZHlDbGFpbWVkYCBvbiByZXBsYXkuCi0gYFplcm9TY29yZU5vdEFsbG93ZWRgIG9yIGBTY29yZU5vdEltcHJvdmVkYCBmb3IgcG9saWN5IHZpb2xhdGlvbnMuAAAAAAxzdWJtaXRfc2NvcmUAAAACAAAAAAAAAARzZWFsAAAADgAAAAAAAAALam91cm5hbF9yYXcAAAAADgAAAAEAAAPpAAAABAAAB9AAAAAKU2NvcmVFcnJvcgAA",
        "AAAAAAAAAIVWZXJpZnkgYSBSSVNDIFplcm8gcHJvb2Ygd2l0aG91dCBtaW50aW5nIHJld2FyZHMgb3IgbXV0YXRpbmcgY2xhaW0gc3RhdGUuCgpSZXR1cm5zIHRoZSBgZmluYWxfc2NvcmVgIGNhcnJpZWQgYnkgdGhlIHZlcmlmaWVkIGpvdXJuYWwuAAAAAAAADHZlcmlmeV9zY29yZQAAAAIAAAAAAAAABHNlYWwAAAAOAAAAAAAAAAtqb3VybmFsX3JhdwAAAAAOAAAAAQAAA+kAAAAEAAAH0AAAAApTY29yZUVycm9yAAA=",
        "AAAAAAAAAW1Jbml0aWFsaXplIGltbXV0YWJsZSBhbmQgbXV0YWJsZSBjb25maWd1cmF0aW9uIGZvciB0aGUgY29udHJhY3QgaW5zdGFuY2UuCgpBcmd1bWVudHM6Ci0gYGVudmA6IFNvcm9iYW4gZXhlY3V0aW9uIGVudmlyb25tZW50LgotIGBhZG1pbmA6IEFkZHJlc3MgYXV0aG9yaXplZCBmb3IgYWRtaW4tb25seSBtZXRob2RzLgotIGB2ZXJpZmllcl9pZGA6IFJJU0MgWmVybyBHcm90aDE2IHZlcmlmaWVyIGNvbnRyYWN0IGFkZHJlc3MuCi0gYGltYWdlX2lkYDogRXhwZWN0ZWQgUklTQyBaZXJvIGltYWdlIElEIGZvciB2YWxpZCByZWNlaXB0cy4KLSBgdG9rZW5faWRgOiBTdGVsbGFyIGFzc2V0IGNvbnRyYWN0IHVzZWQgZm9yIHJld2FyZCBtaW50aW5nLgAAAAAAAA1fX2NvbnN0cnVjdG9yAAAAAAAABAAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAt2ZXJpZmllcl9pZAAAAAATAAAAAAAAAAhpbWFnZV9pZAAAA+4AAAAgAAAAAAAAAAh0b2tlbl9pZAAAABMAAAAA",
        "AAAAAAAAAC1BZG1pbjogdXBkYXRlIHRoZSBSSVNDIFplcm8gdmVyaWZpZXIgYWRkcmVzcy4AAAAAAAAPc2V0X3ZlcmlmaWVyX2lkAAAAAAEAAAAAAAAAD25ld192ZXJpZmllcl9pZAAAAAATAAAAAA==" ]),
      options
    )
  }
  public readonly fromJSON = {
    upgrade: this.txFromJSON<null>,
        image_id: this.txFromJSON<Buffer>,
        token_id: this.txFromJSON<string>,
        set_admin: this.txFromJSON<null>,
        best_score: this.txFromJSON<u32>,
        is_claimed: this.txFromJSON<boolean>,
        set_paused: this.txFromJSON<null>,
        verifier_id: this.txFromJSON<string>,
        current_seed: this.txFromJSON<CurrentSeed>,
        rules_digest: this.txFromJSON<u32>,
        set_image_id: this.txFromJSON<null>,
        set_token_id: this.txFromJSON<null>,
        submit_score: this.txFromJSON<Result<u32>>,
        verify_score: this.txFromJSON<Result<u32>>,
        set_verifier_id: this.txFromJSON<null>
  }
}