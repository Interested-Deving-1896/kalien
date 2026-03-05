import { describe, expect, it } from "bun:test";
import { countProofTapeMappings } from "../../worker/leaderboard-store";
import type { WorkerEnv } from "../../worker/env";

function makeEnv(db: D1Database): WorkerEnv {
  return {
    LEADERBOARD_DB: db,
  } as WorkerEnv;
}

function makeLegacyProofTapeDb(): {
  db: D1Database;
  executedStatements: string[];
} {
  let mappedAtColumnExists = false;
  const executedStatements: string[] = [];

  const db = {
    prepare(statement: string) {
      return {
        async run() {
          executedStatements.push(statement);

          if (statement.includes("ALTER TABLE proof_tape_index ADD COLUMN mapped_at")) {
            mappedAtColumnExists = true;
            return { success: true };
          }

          if (
            statement.includes("CREATE INDEX IF NOT EXISTS idx_proof_tape_index_mapped_at") &&
            !mappedAtColumnExists
          ) {
            throw new Error("D1_ERROR: no such column: mapped_at");
          }

          return { success: true };
        },
        async first<T>() {
          return { total: 0 } as T;
        },
      };
    },
  } as unknown as D1Database;

  return {
    db,
    executedStatements,
  };
}

describe("leaderboard store schema migration", () => {
  it("adds mapped_at before creating the mapped_at index on legacy proof_tape_index tables", async () => {
    const legacyDb = makeLegacyProofTapeDb();

    await expect(countProofTapeMappings(makeEnv(legacyDb.db))).resolves.toBe(0);

    const alterIndex = legacyDb.executedStatements.findIndex((statement) =>
      statement.includes("ALTER TABLE proof_tape_index ADD COLUMN mapped_at"),
    );
    const createIndexIndex = legacyDb.executedStatements.findIndex((statement) =>
      statement.includes("CREATE INDEX IF NOT EXISTS idx_proof_tape_index_mapped_at"),
    );

    expect(alterIndex).toBeGreaterThanOrEqual(0);
    expect(createIndexIndex).toBeGreaterThan(alterIndex);
  });
});
