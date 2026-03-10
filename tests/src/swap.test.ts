import { describe, expect, it } from "bun:test";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { buildSignedSwapSubmissionXdr, requireSwapSubmissionHash } from "../../src/chain/swap";

describe("buildSignedSwapSubmissionXdr", () => {
  it("re-signs the rebuilt transaction before relay submission", () => {
    const deployer = Keypair.random();
    const sourceAccount = new Account(deployer.publicKey(), "1");
    const router = new Contract("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4");

    const assembled = new TransactionBuilder(sourceAccount, {
      fee: "1000000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(router.call("swap_exact_tokens_for_tokens"))
      .setTimeout(300)
      .build();

    expect(assembled.signatures).toHaveLength(0);

    const signedXdr = buildSignedSwapSubmissionXdr(
      assembled.toXDR(),
      [],
      Networks.TESTNET,
      (rebuiltTx) => {
        rebuiltTx.sign(deployer);
      },
    );

    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);

    const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, "base64");
    const auth = envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth();
    expect(auth).toHaveLength(0);
  });

  it("rejects relay responses that omit the transaction hash", () => {
    expect(() => requireSwapSubmissionHash({ success: true, data: {} })).toThrow(
      "swap submission missing tx hash",
    );
  });
});
