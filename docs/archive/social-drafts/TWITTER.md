# KALIEN X Article

## Title

KALIEN Is an Asteroids Game. The More Interesting Part Is What It Says About ZK on Stellar.

## Deck

KALIEN is a competitive Asteroids game where every score is the output of a deterministic state machine, proved with RISC Zero, and settled onchain on Stellar. It is also a test bed for a pattern I think matters way beyond games: do the heavy compute offchain, prove the result, and let the chain do the one small thing it is actually good at.

## Article

Games are a really nice place to test legitimacy because everyone immediately understands the failure mode.

The leaderboard says some guy scored 84,390 points. Cool. Says who?

Usually the answer is "our server did."

That is fine right up until it isn't. Someone tampers with a request. Someone finds a weird client edge case. Someone with the right database access fixes things by hand. Most leaderboards are not malicious. They are just trust based. And once you start hanging real value on that leaderboard, "trust based" is not a great foundation.

KALIEN is me poking at a stricter model.

### The game

On the surface it is an Asteroids game. A real one. Ship physics. Asteroid splitting. Saucers. Wave pressure. Short competitive rounds. You can play it in a browser. You can play it from a CLI. The whole thing.

The rule set is called AST4 and it is intentionally constrained. You get 3 lives. Extra life every 10,000 points. Asteroids pay 20, 50, and 100 depending on size. Saucers pay 200 or 990. Anti-lurk pressure kicks in after 6 seconds so you cannot just hide in a corner. Runs cap at 10 minutes.

That is not random game tuning. That is product design in service of verification. Every one of those constraints exists to keep the proving path practical and the competition fair.

But the game itself is not really the part I care about most. The more interesting part is the architecture underneath it.

### How it actually works

The question I wanted to answer: can zk become a practical way to do complex offchain computation and still let onchain systems make safe decisions?

Here is how KALIEN answers it.

While you play, the game records a compact tape of your inputs. The input model is intentionally tiny: 4 action bits per frame. Thrust, rotate left, rotate right, fire. That is it. The game rules are deterministic and integer based, so given the same seed and the same frame inputs you get the exact same run and the exact same score. Every time.

That means a score is no longer just a claim. It is the output of a replayable state machine. And that changes everything about how you can verify it.

The end-to-end flow looks like this:

1. You play the game and the tape records your inputs
2. The tape gets submitted to a worker gateway that validates it and binds it to your address and the current seed window
3. The tape is handed to a RISC Zero proof pipeline where a prover replays the entire run inside a zkVM and produces a Groth16 proof
4. The resulting 260-byte seal and 49-byte journal get relayed to Stellar
5. The score contract on Stellar does only the small amount of work it actually needs to do

That last step is the important one. From the chain's perspective the entire 10 minute simulation collapses into a tiny verification:

- Verify the Groth16 proof against the expected image and journal digest
- Check that the seed window is active
- Check that the submission is bound to the correct claimant
- Check that the score actually improved the claimant's previous best

If all that passes, and only then, the contract mints the delta. Not the full score. The delta. If your previous best in a seed window was 5,000 and you improved to 8,000, you earn 3,000 KALIEN. The contract only ever mints the improvement.

That is the pattern. Not "put everything onchain." Not "trust the backend." Not "make the contract re-run the whole universe." Do the heavy work offchain. Prove the policy-relevant result. Let the chain make the final decision.

### Why Stellar, and why now

This is very explicitly a Stellar experiment, and the timing is not an accident.

Stellar's Protocol 25, code-named X-Ray, went live on mainnet on January 22, 2026. That upgrade added native BN254 host functions (the same pairing-friendly elliptic curve used by Ethereum's precompiles) plus Poseidon and Poseidon2 hash primitives. If you care about zk on Stellar, that upgrade is a pretty big deal.

BN254 means Stellar can now natively verify Groth16 proofs. Pairing checks, point multiplication, point addition, all as host functions. No awkward workarounds, no simulating elliptic curve arithmetic in Soroban. The Groth16 verifier contract deployed on mainnet is stateless, admin-less, and just works.

Poseidon and Poseidon2 give developers hash primitives that are far more efficient inside arithmetic circuits than dragging SHA-256 or Keccak through a zk pipeline and paying for the privilege. If you are building proof systems that touch Stellar, these are the hashes you want.

KALIEN is one of the first production applications exercising these capabilities on mainnet. It is a live poke at what Protocol 25 actually makes possible, not in theory, but in a system people are actively competing in right now.

For official background:

- [Protocol 25 / X-Ray announcement](https://stellar.org/blog/developers/announcing-stellar-x-ray-protocol-25)
- [ZK Proofs on Stellar docs](https://developers.stellar.org/docs/build/apps/zk)
- [X-Ray upgrade guide](https://stellar.org/blog/developers/stellar-x-ray-protocol-25-upgrade-guide)

### The economy

KALIEN tokens are not a number on a leaderboard. They are a Stellar asset with real onchain liquidity.

If you are familiar with the Stellar ecosystem you probably know KALE, the community proof-of-work mining token that has been running since late 2024. KALE has its own farming community, its own ecosystem of tools and trading, and it generated a remarkable amount of Stellar network activity during the Protocol 23 stress testing period. The 100-millionth Soroban smart contract transaction on mainnet was a KALE plant invocation.

KALIEN extends that orbit. There is a live KALE/KALIEN liquidity pool on Soroswap seeded with 40 million KALE and 4 trillion KALIEN, sitting at a ratio of roughly 100,000 KALIEN per 1 KALE. The web app even has a built-in swap so you can convert KALIEN to KALE directly from your wallet.

- [KALE/KALIEN pool on Stellar Expert](https://stellar.expert/explorer/public/contract/CCWX3RMBJIHSUBRZ22TMYHVGMSLUK6OMDYCV35JSQD76HZ2BCD36RSLL)

What this means in practice: scoring well in an Asteroids game yields a token with actual onchain liquidity connected into a broader token ecosystem. That is a weird sentence to write but it is true.

### The wallet

One thing I care about a lot is UX, and the worst possible version of this project would be one where you have to install a browser extension and manage a seed phrase before you can play a game.

KALIEN uses Stellar smart wallets backed by passkeys. You pick a username, your device prompts for Face ID or Touch ID, and you have a wallet. That is it. No seed phrase. No extension. No key management. The passkey stored in your device's secure enclave is the key. Transactions are signed client-side using WebAuthn and submitted through a relayer that handles fees, so you do not even need to hold XLM.

It is a much saner starting point for a game that normal people might actually want to play.

### The CLI farmer

If you want to take things further, there is a CLI.

`kalien run --address G... --threads max` will turn your machine into an autonomous asteroid-flavored proof factory. The CLI spawns worker threads that play the game using an AI autopilot, track the best scores, and automatically submit improvements to the proof pipeline. One worker is the "exploiter" (small mutations, tracking the best known strategy), the rest are "explorers" (large mutations, independent search, restarting from random when they stall).

It has a live terminal dashboard. Games played, best score, epoch countdown, worker scores, submission status. You can watch it work.

The competition runs on rolling 10 minute seed windows. Every 10 minutes the seed changes and everyone starts fresh. There are 24 hour and all-time views layered on top. So you can compete on the current window, the daily leaderboard, or the long game.

### People are already pushing the ceiling

Fred Kyung-jin Rezeau recently published a writeup on scoring over one million points in a single tape: 1,082,860 points, zero deaths, all verified onchain.

He did not use the built-in autopilot. He ported the entire KALIEN TypeScript game engine to CUDA and ran a beam search algorithm on GPU. His key insight was reweighting the fitness function to penalize evasion and reward aggression. A single line change was the breakthrough.

The catch? With ZK there is no tolerance. The CUDA port had to be bit-perfect against the TypeScript reference implementation. One subtle bug in child array ordering that reversed iteration compared to JavaScript would have gotten the proof rejected. He found it, fixed it, and the million-point tape verified.

That is what I love about this system. You can bring whatever strategy you want. Human play, built-in autopilot, your own custom AI, a GPU-powered beam search. The rules do not care. They only care that the tape replays correctly and the proof verifies.

- [The One Million KALIEN Tape](https://kyungj.in/posts/million-kalien-tape-stellar-zk-gaming/)

### The bigger picture

I think people should read KALIEN less like "neat, a game with proofs" and more like "okay, this is one clean test harness for a broader architecture."

The game makes the pattern legible. It is very easy to explain why a leaderboard should not just be a database row someone wrote. It is very easy to see why the chain should only care about a small final statement instead of a full 10 minute simulation.

But that same shape applies to a lot of things that are not games:

- Tournament scoring and reward calculation
- Agent-selected actions that need authorization
- Routing and matching decisions
- Simulation-driven allocations
- Reputation and ranking systems
- Any workflow where the hard part happens offchain but the final action still needs to be safe onchain

Whenever a product says "we ran the policy engine" or "the agent found the right move" or "the backend decided this reward is earned," the real question is not whether the offchain system is clever. The real question is whether the chain has enough evidence to safely do the one thing you are asking it to do.

That is the utility of zk here. Not just privacy. Not just novelty. It is a way to turn rich offchain execution into a compact thing an onchain system can verify before it moves value, updates state, or grants permission.

And if that pattern holds up under something as noisy and adversarial as a competitive game, that is a pretty encouraging sign for bigger and more useful things.

### Go play it

KALIEN benefits from being an actual thing you can touch instead of just a diagram in a pitch deck.

You can play it. You can submit runs. You can watch proof jobs process. You can inspect the leaderboard. You can read the contract. You can swap KALIEN for KALE. You can run the CLI and turn your machine into a farm. You can steal the pattern and build your own version of this for whatever domain you care about.

If you want to poke at the edges, share runs, or build your own weird extension of this thing, jump into the Stellar Global Discord:

- [Stellar Global Discord](https://discord.gg/FXYnUmFqTa)

Play KALIEN: [https://kalien.xyz](https://kalien.xyz)

Code: [https://github.com/kalepail/kalien](https://github.com/kalepail/kalien)

## Suggested Media

- Hero image: gameplay screen or branded game capture
- Mid-article image: leaderboard showing 10m, 24h, and all-time windows
- Mid-article image: proof-status UI or wallet flow
- CLI dashboard or ASCII replay screenshot
- KALE/KALIEN Soroswap pool screenshot

## Companion Post

KALIEN is an Asteroids game built on Stellar with ZK proof verification, a token economy with real liquidity, and a CLI farmer. But the more interesting part is the architecture: do the big compute offchain, prove the result, let the chain do one small safe thing. The game is the demo. The pattern is the point. X Article: [paste article link]

## Editorial Notes

- Keep "proved runs" language throughout. Avoid "every score is a proof."
- Do not imply Boundless is the only proving backend.
- Do not hardcode proof cost or proof latency claims.
- Do not claim the system has no admin or upgrade controls.
- Keep the wallet framing around passkey-backed usability, not absolute trustlessness.
