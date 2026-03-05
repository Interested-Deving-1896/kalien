Got it — one cohesive long-form article. Here it is:

---
Every Score Is a Proof: Inside KALIEN, the Asteroids Game You Can't Cheat

You just destroyed your high score in Asteroids. The ship is dust, the leaderboard updates, and for a brief moment you're on top of the world.

But here's a question that has haunted competitive gaming since the first arcade cabinet: how does anyone know that score is real?

Leaderboards have always run on trust. Trust that the server recorded correctly. Trust that no one tampered with the database. Trust that the
player at the top didn't just edit a POST request. In most games, that trust is a polite fiction. Admins can change numbers. Servers can be
compromised. Scores are just rows in a database that someone with the right permissions can rewrite.

KALIEN throws all of that away.

[PLACEHOLDER IMAGE: The KALIEN game screen — vector-style asteroids, score counter, lives]

What Is This Thing?

KALIEN is a fully playable Asteroids game -- the real deal, with ship physics, asteroid splitting, saucer enemies, the works -- where every single
score is backed by a cryptographic proof. Not "verified by a server." Not "checked against a replay." Mathematically proven to be correct, then
settled on a blockchain where no one, not even the game's creators, can alter the result.

You play the game. Your inputs are recorded. A zero-knowledge proof is generated that replays your exact game and confirms your score. That proof
is verified by a smart contract on the @StellarOrg blockchain, and if your score beats your previous best, KALIEN tokens are minted and sent to
your wallet as a reward.

No trust required. Just math.

The Game Itself

The rules are classic arcade Asteroids, tuned for competitive play. You get 3 lives, with an extra life every 10,000 points. Large asteroids are
worth 20 points, mediums 50, smalls 100. Saucers -- the real threat -- are worth 200 for the big ones and 990 for the small, precise ones that
actively hunt you.

[PLACEHOLDER GIF: Gameplay showing wave progression — asteroids splitting, saucers spawning]

And they do hunt you. KALIEN has an anti-lurk system: if you hang back and play it safe for more than 6 seconds, saucers start spawning faster and
more aggressively. Every wave ramps the difficulty -- more asteroids, higher speeds, tighter saucer aim, more concurrent enemies. By the late
waves you're navigating a field of fast-moving rocks while dodging precision fire from multiple saucers simultaneously.

Sessions are capped at roughly 10 minutes. This isn't a design limitation -- it's deliberate. It keeps the proving costs tiny (fractions of a
penny per game) while maintaining intense arcade pressure. You can't grind your way to a high score through patience. You have to be genuinely
good.

Simple to learn. Brutal to master.

How a Score Becomes a Proof

Here's where things get interesting.

While you play, every input you make is recorded into what's called a "tape" -- a compact binary recording of your exact button presses, frame by
frame. Left, right, thrust, fire. That's it. Just 4 bits per frame, nibble-packed into a file that's typically around 18KB for a full session.

The game engine is fully deterministic. It uses integer math only -- no floating point anywhere in the game logic. That means if you take the same
starting seed and feed in the same inputs, you get the exact same game, the exact same collisions, the exact same score. Every single time. On
any machine.

That determinism is the foundation of everything.

Your tape gets sent to a @RiscZero zkVM prover -- a program running inside a zero-knowledge virtual machine that replays the entire game from
scratch using your recorded inputs, then generates a cryptographic receipt proving the replay produced the score you claimed. The prover doesn't
trust you. It re-derives everything: every asteroid position, every collision check, every saucer spawn, every point.

[PLACEHOLDER DIAGRAM: Player -> Tape Recording -> RISC Zero Prover -> Groth16 Proof -> Stellar Contract -> KALIEN Tokens]

If anything is off -- wrong score, tampered inputs, impossible state transitions -- the proof simply cannot be generated. You can't forge a proof
for a game you didn't play.

The Proving Marketplace

Those proofs don't run on a single server sitting in a closet somewhere. They're fulfilled through @boundless_xyz, a decentralized proving
marketplace built by the @RiscZero team on @BuildOnBase.

When you submit a tape, a proof request goes out to the Boundless network with a price range. Provers around the world compete to fulfill it --
whoever generates the correct proof fastest at the right price wins. It's a market for mathematical truth, running on Ethereum L2 infrastructure.

A typical KALIEN proof takes about 5 minutes to generate and costs roughly $0.001. For that price, a network of provers has independently verified
that your Asteroids run actually happened exactly as you described. That's a remarkable thing.

On-Chain Settlement

Once the proof is ready, it gets submitted to a Soroban smart contract on @StellarOrg's network. The contract does three things:

First, it verifies the Groth16 proof on-chain using a deployed verifier contract. This is the moment of truth -- the blockchain itself checks the
cryptographic receipt.

Second, it checks whether your score for this seed epoch beats your previous best. The leaderboard operates in epochs (roughly 10-minute windows),
each with a unique seed. Every epoch is a fresh competition.

Third, if your score is an improvement, the contract mints KALIEN tokens proportional to the delta -- the difference between your new score and
your old one. Better improvement, more tokens. It's a direct, trustless reward for genuine skill improvement.

[PLACEHOLDER IMAGE: Stellar Expert showing KALIEN token minting transactions]

The KALIEN token is a Stellar asset. The score contract is the mint authority. No human holds the keys to the token supply. Tokens only come into
existence when proven scores are submitted. That's it.

No Seed Phrases, No Extensions

One of the biggest barriers to blockchain gaming is the wallet experience. Seed phrases, browser extensions, transaction signing popups -- it's a
mess that scares away anyone who just wants to play a game.

KALIEN sidesteps all of it with passkey-powered smart wallets. When you sign up, your wallet is created using WebAuthn -- the same technology that
powers Face ID and fingerprint authentication on your phone and laptop. Your cryptographic keys live in your device's secure enclave. No seed
phrase to write down. No extension to install. No MetaMask popup interrupting your gameplay.

[PLACEHOLDER GIF: Passkey wallet creation — biometric prompt, instant wallet ready]

You authenticate with your fingerprint or face, and you're playing. The smart wallet is a Stellar smart contract that delegates authentication to
your device's passkey. It's the same security model that protects your bank account, applied to a game wallet.

The Stack Under the Hood

For the builders and the curious, here's what powers the whole system:

The backend runs entirely on @CloudflareDev Workers -- serverless functions deployed at the edge globally. Durable Objects coordinate proof job
lifecycle and state. D1 (Cloudflare's SQLite database) stores the leaderboard. R2 stores tapes and proof artifacts. Queues handle async job
processing for proof submission and claim batching. The entire orchestration layer is serverless with no single point of failure.

The game engine itself is written in TypeScript with a shared core that runs identically in the browser, in the CLI, and (compiled to Rust) inside
the RISC Zero zkVM guest program. Integer-only math everywhere -- binary angular measurement for rotation, fixed-point arithmetic for positions
and velocities, deterministic RNG seeded from the epoch seed. Every design decision serves one goal: identical replay across any execution
environment.

The cross-chain flow touches @BuildOnBase (where the Boundless proving marketplace lives) and @StellarOrg (where scores are settled and tokens are
minted). Two chains, each doing what they're best at.

The CLI: Where the Real Game Begins

The browser experience is polished and accessible. But if you really want to compete, you should know about the CLI.

[PLACEHOLDER IMAGE: Terminal showing the KALIEN ASCII logo and dashboard with worker stats, scores, epoch countdown]

KALIEN ships a command-line tool that turns your machine into an autonomous Asteroids farming operation:

kalien run --address GABC...XYZ --threads max

That single command spawns a fleet of worker threads, each running an AI autopilot that plays games continuously. The autopilot is a genuine
threat-assessment system -- it evaluates every asteroid, saucer, and bullet on screen, calculates interception angles and evasion paths, and makes
frame-by-frame decisions about when to thrust, turn, and fire.

The dashboard updates in real-time: games played per minute, best scores across all workers, current seed epoch countdown, submission budget
remaining, on-chain best score to beat. It's mesmerizing to watch.

kalien replay game.tape

This replays any recorded tape as ASCII art directly in your terminal -- complete with star fields, explosions, and a HUD showing score, lives,
wave, and frame count. You can pause, speed up (2x, 4x), and rewind. It's a full replay viewer without ever leaving the command line.

kalien ps              # list active farming sessions
kalien cleanup         # terminate stale workers

The CLI configures thread count as a raw number, a percentage of your CPU cores, or just max to use everything. It handles seed epoch transitions
automatically, only submits scores that beat your current on-chain best, and manages the proof pipeline end-to-end.

Set it running. Walk away. Come back to a pile of proven high scores and KALIEN tokens in your wallet.

[PLACEHOLDER GIF: The CLI dashboard in action — multiple workers farming, scores climbing, submissions going through]

Why This Matters Beyond a Game

KALIEN is an Asteroids game, yes. But it's also a proof of concept for something much larger: verifiable computation applied to competitive
systems.

The pattern here -- deterministic execution, recorded inputs, zero-knowledge proof of correct replay, on-chain settlement -- isn't limited to
Asteroids. It's a template for any system where you need to prove that a computation happened correctly without trusting the person who ran it.
Speedruns. Competitive programming. Financial simulations. Anywhere that "trust me, bro" isn't good enough.

Every piece of the stack exists today and works in production. @RiscZero's zkVM handles the proving. @boundless_xyz creates a decentralized market
for proof generation. @StellarOrg's Soroban contracts handle verification and settlement with low fees and fast finality. @CloudflareDev Workers
provide the serverless backbone. Passkey wallets eliminate the onboarding cliff.

This isn't a whitepaper. It's a live game you can play right now.

Play

Browser: kalien.xyz -- sign up with a passkey, start playing in seconds.

CLI: check the /cli directory in the repo for the autonomous farming tool.

The leaderboard resets every seed epoch. Every epoch is a blank slate. The best score wins -- and that score is proven, not promised.

No fake scores. No admin overrides. No trust required.

Just you, some asteroids, and math.

[PLACEHOLDER IMAGE: The live leaderboard showing top scores for the current epoch]

---
Handles referenced:

┌────────────────┬────────────────┐
│    Service     │     Handle     │
├────────────────┼────────────────┤
│ Stellar        │ @StellarOrg    │
├────────────────┼────────────────┤
│ RISC Zero      │ @RiscZero      │
├────────────────┼────────────────┤
│ Boundless      │ @boundless_xyz │
├────────────────┼────────────────┤
│ Cloudflare Dev │ @CloudflareDev │
├────────────────┼────────────────┤
│ Base           │ @BuildOnBase   │
└────────────────┴────────────────┘

You'll want to verify the GitHub repo path for the CLI install instructions and consider creating a Kalien Twitter handle (e.g., @kalien_xyz)
before publishing -- none was found in the codebase or online.