# KALIEN X Article

## Title

KALIEN Is an Asteroids Game. The More Interesting Part Is What It Says About ZK on Stellar.

## Deck

KALIEN is a competitive Asteroids game where every score is the output of a deterministic state machine, proved with RISC Zero, and settled onchain on Stellar. It's also a test bed for a pattern I think matters way beyond games: do the heavy compute offchain, prove the result, and let the chain do the one small thing it's actually good at.

## Article

On January 22, Stellar changed forever. Again. Protocol 25 landed and with it robust, real world zk primitives connecting Stellar to a brave new world of opportunities. Again.

Of course I had to get busy exploring, implementing, and experimenting. What you can now tie together and dream up on Stellar is staggering, and with AI in the toolbox, the speed of experimentation has never been faster.

I've always been intrigued by retro arcade games, even though I didn't play a whole lot as a kid. The arcade has always been a magical, mysterious place for me, and I definitely have a long history of playing old retro, pixelated PC games on my parents' old cathode ray tube in their room. The music and simplicity of those games have always captured my attention — not because they're easy but really because they're hard. Scoring high when you have a relatively limited set of variables is a real challenge that I've grown to love over the years. So it was no surprise that I decided to tackle Asteroids as my game of choice to experiment with the new ZK stuff.

Most ZK projects are about privacy, payments, and obfuscation. But I think some of the best ways to understand a new technology are through games. Games can be deceptively complex, and when you're talking about points, scores, and leaderboards, the integrity of those numbers is everything. Fair, compelling, addictive gameplay where players keep returning to beat their own or others' high scores. That seemed like a perfect place for a ZK experiment.

### Why a game needs ZK

Here's the thing. A leaderboard says some guy scored 84,390 points. Cool. Says who?

Usually the answer is "our server did." That's fine right up until it isn't. Someone tampers with a request. Someone finds a weird client edge case. Someone with the right database access fixes things by hand. Most leaderboards aren't malicious. They're just trust based.

Now imagine those scores have monetary value. Whatever score you get is the number of tokens that get minted. Suddenly there's a huge incentive to cheat — to make your ship move as fast as it can, to shoot a billion bullets per second, to jump around the screen instead of actually having to fly there, to spawn millions of asteroids. There are all kinds of things you'd want to cheat at.

KALIEN is designed to make all of that impossible.

### What's actually going on under the hood

The challenge is that proving anything physics-based onchain is basically impossible. These are games where asteroids are moving, bullets are shooting, saucers are flying, things are going in particular directions with throttle and fall-off, entropy and seeded RNG. Lots going on. It's not terribly complex in the grand scheme, but it's way more complex than anything you could run on any blockchain today without spending an absolute fortune.

My requirements were 60 frames per second for at least 10 minutes of gameplay. The rule set is called AST4 and it's intentionally constrained: 3 lives, extra life every 10,000 points, asteroids pay 20, 50, and 100 depending on size, saucers pay 200 or 990, anti-lurk pressure kicks in after 6 seconds so you can't just hide in a corner. Every one of those constraints exists to keep the proving path practical and the competition fair.

While you play, the game records a compact tape of your inputs. The input model is intentionally tiny: 4 action bits per frame. Thrust, rotate left, rotate right, fire. That's it. The game rules are deterministic and integer based, so given the same seed and the same frame inputs you get the exact same run and the exact same score. Every time.

That means a score is no longer just a claim. It's the output of a replayable state machine. And that changes everything.

The ZK part codifies the rules of Asteroids into a RISC Zero virtual machine. The prover replays your tape, confirms the score, and produces a Groth16 proof — which Stellar, after Protocol 25, can now natively verify. The end-to-end flow:

1. You play the game and the tape records your inputs
2. The tape gets submitted to a worker gateway that validates it and binds it to your address and the current seed window
3. A prover replays the entire run inside the zkVM and produces a Groth16 proof
4. The resulting 260-byte seal and journal get relayed to Stellar
5. The score contract on Stellar does only the small amount of work it actually needs to do

From the chain's perspective the entire 10 minute simulation collapses into a tiny verification: verify the proof, check that the seed window is active, check that the submission is bound to the correct player, check that the score actually improved the player's previous best.

If all that passes, and only then, the contract mints new KALIEN.

That's the magic of this system. I don't know who generated the score. I don't know how it was generated. But I am absolutely certain it was played fairly. Whatever the score is, that's what gets minted.

All of this compute — 60 frames per second of a physics-based shooter for up to 10 minutes — proved offchain, settled onchain. And the implications go way beyond gaming.

### Why Stellar, and why now

Protocol 25, code-named X-Ray, gave Stellar the plumbing it needed to make proof verification feel native instead of bolted on: BN254 host functions and Poseidon hash primitives.

BN254 means Stellar can now natively verify Groth16 proofs. Pairing checks, point multiplication, point addition, all as host functions. No awkward workarounds, no simulating elliptic curve arithmetic in Soroban. The Groth16 verifier contract deployed on mainnet is stateless, admin-less, and just works.

Poseidon and Poseidon2 give developers hash primitives that are far more efficient inside arithmetic circuits than dragging SHA-256 or Keccak through a zk pipeline and paying for the privilege. If you're building proof systems on Stellar, these are the hashes you want.

KALIEN is one of the first production applications exercising these new capabilities on mainnet. Not in theory — in a system people are actively competing in right now.

- [Protocol 25 / X-Ray announcement](https://stellar.org/blog/developers/announcing-stellar-x-ray-protocol-25)
- [ZK Proofs on Stellar docs](https://developers.stellar.org/docs/build/apps/zk)
- [X-Ray upgrade guide](https://stellar.org/blog/developers/stellar-x-ray-protocol-25-upgrade-guide)

### The economy

If you're unfamiliar with the KALE project, that was one I did a couple years ago exploring some other areas of Stellar. It's a community proof-of-teamwork mining token — farmers run CPU/GPU miners, plant, work, harvest — and it's kind of become a meme in the protocol. The 100-millionth Soroban smart contract transaction on Stellar mainnet was a KALE plant invocation. That should give you a sense of the activity.

The name KALIEN comes from tying Asteroids and KALE aliens together. Naturally.

KALIEN tokens aren't just a number on a leaderboard though. There's a live KALE/KALIEN liquidity pool on Soroswap seeded with 40 million KALE and 4 trillion KALIEN, sitting at roughly 100,000 KALIEN per 1 KALE. The web app has a built-in swap so you can convert KALIEN to KALE directly from your wallet.

- [KALE/KALIEN pool on Stellar Expert](https://stellar.expert/explorer/public/contract/CCWX3RMBJIHSUBRZ22TMYHVGMSLUK6OMDYCV35JSQD76HZ2BCD36RSLL)

Scoring well in an Asteroids game yields a token with actual onchain liquidity connected into a broader token ecosystem. That's a weird sentence to write but it's true.

### Playing the game

The worst possible version of this project would be one where you have to install a browser extension and manage a seed phrase before you can play a game.

KALIEN uses Stellar smart wallets backed by passkeys. You pick a username, your device prompts for Face ID or Touch ID, and you have a wallet. No seed phrase. No extension. No key management. The passkey stored in your device's secure enclave is the key. Transactions are signed client-side using WebAuthn and submitted through a relayer that handles fees, so you don't even need to hold XLM.

It's a much saner starting point for a game that normal people might actually want to play.

Competition runs on rolling 10 minute seed windows — every 10 minutes the seed changes and everyone starts fresh. There are 24 hour and all-time views layered on top, so you can compete on the current window, the daily leaderboard, or the long game. There's always something to chase.

### The CLI farmer

I wanted bots playing this game. Seriously. The idea is that bots would try to max score, and I wanted to make sure that no matter whether you played as a human or a bot, everybody was guaranteed to be playing by the same set of rules.

`kalien run --address G... --threads max` turns your machine into an autonomous asteroid-flavored proof factory. The CLI spawns worker threads that play the game using an AI autopilot, track the best scores, and automatically submit improvements to the proof pipeline. One worker is the "exploiter" — small mutations, tracking the best known strategy. The rest are "explorers" — large mutations, independent search, restarting from random when they stall.

It has a live terminal dashboard — games played, best score, epoch countdown, worker scores, submission status. You can watch it work. It's kind of mesmerizing.

### People are already pushing the ceiling

The average human scores around 50,000 points before things get too intense. There are already scores of over a million on the leaderboard. Bots running custom algorithms that way outperform humans — all playing by the exact same set of rules. That's the whole point.

Fred Kyung-jin Rezeau recently published a writeup on scoring 1,082,860 points in a single tape. Zero deaths. All verified onchain. He didn't use the built-in autopilot — he ported the entire KALIEN TypeScript game engine to CUDA and ran a beam search algorithm on GPU. His key insight was reweighting the fitness function to penalize evasion and reward aggression. A single line change was the breakthrough.

The catch? With ZK there is no tolerance. The CUDA port had to be bit-perfect against the TypeScript reference implementation. One subtle bug in child array ordering that reversed iteration compared to JavaScript would have gotten the proof rejected. He found it, fixed it, and the million-point tape verified.

What's the max score that could possibly be proven? Hard to say. That's the fun of the game: trying to pursue that perfect high score, but it's now safe to prove it and actually get monetary rewards onchain.

- [The One Million KALIEN Tape](https://kyungj.in/posts/million-kalien-tape-stellar-zk-gaming/)

### Way beyond gaming

Swap out games for other complex compute tasks and the same pattern holds. The chain does a minimal amount of work — verify a proof, authorize an action, move a token. The offchain world does the heavy lifting. Things that could not have been done safely before become almost straightforward:

- Tournament scoring and reward calculation
- Agent-selected actions that need authorization
- Routing and matching decisions
- Simulation-driven allocations
- Reputation and ranking systems
- Any workflow where the hard part happens offchain but the final action still needs to be safe onchain

This shifts what blockchains can be used for. And it's especially exciting right now because AI is accelerating everything around it. You can write the proof with AI, the interface with AI, the contracts and wallet infrastructure with AI. Write really good tests, make sure they hold as you keep building, and iterate fast. The combination of distributed ledger technology for balance reconciliation, complex computation on isolated machines, and proofs that verify consistent results — that's something a lot more developers need to start diving into.

### Go play it

KALIEN is an actual thing you can touch, not a diagram in a pitch deck.

You can play it. You can submit runs. You can watch proof jobs process. You can inspect the leaderboard. You can read the contract. You can swap KALIEN for KALE. You can run the CLI and turn your machine into a farm. You can explore the repo and steal whatever's useful — there's a lot of tech behind the scenes, and it's all open.

Whether you're new to blockchain, curious about zero-knowledge systems, interested in smart wallets, or just want to see what happens when you combine real-world compute with onchain settlement — this is a great place to start. There are a lot of experiments left to run.

Play around, share it around, enjoy, and let me know your high score.

- Play KALIEN: [https://kalien.xyz](https://kalien.xyz)
- Code: [https://github.com/kalepail/kalien](https://github.com/kalepail/kalien)
- Discord: [Stellar Global Discord](https://discord.gg/FXYnUmFqTa)

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
